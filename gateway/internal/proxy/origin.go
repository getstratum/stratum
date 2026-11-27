package proxy

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// Where a request came from, for Requests in the console: the client's
// address and the program it said it was (User-Agent). An audit asks
// "where did this come from?" and the key alone does not answer it: a key
// can be copied.
//
// The address is the connection's, unless the connection comes from a
// proxy listed in TrustedProxies (an ingress, a load balancer): then the
// rightmost address of X-Forwarded-For that is not itself a trusted
// proxy. A client can write any X-Forwarded-For it likes, so the header
// is never believed from anyone else.

// clientIP is the address the request came from, "" when it cannot tell.
func clientIP(r *http.Request, trusted []netip.Prefix) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return ""
	}
	addr = addr.Unmap()
	if !isTrusted(addr, trusted) {
		return addr.String()
	}
	var hops []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(v, ",")...)
	}
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			return addr.String() // a malformed hop: the last address we know
		}
		a = a.Unmap()
		if !isTrusted(a, trusted) {
			return a.String()
		}
		addr = a
	}
	return addr.String()
}

func isTrusted(a netip.Addr, trusted []netip.Prefix) bool {
	for _, p := range trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// clientAgent is the User-Agent, printable ASCII only, at most 200 bytes.
func clientAgent(r *http.Request) string {
	ua := r.Header.Get("User-Agent")
	var b strings.Builder
	for i := 0; i < len(ua) && b.Len() < 200; i++ {
		if c := ua[i]; c >= 0x20 && c < 0x7f {
			b.WriteByte(c)
		}
	}
	return strings.TrimSpace(b.String())
}
