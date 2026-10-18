package valkey

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"
)

// A managed Valkey (Memorystore with in-transit encryption) is reached by IP
// with a certificate from a CA of its own: the client must verify the IP
// against that CA, and authenticate inside the TLS session.
func TestClientTLSWithPrivateCA(t *testing.T) {
	ca, caKey := newCA(t, "valkey test CA")
	leaf := newLeaf(t, ca, caKey, net.ParseIP("127.0.0.1"))

	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{leaf}, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	srv := serveFake(t, ln)

	o, err := ParseURL("rediss://default:tok3n@" + ln.Addr().String() + "/0")
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	o.TLS.RootCAs = pool
	c := New(o)
	defer c.Close()
	if _, err := c.Do(context.Background(), "PING"); err != nil {
		t.Fatalf("PING over TLS: %v", err)
	}
	if got := srv.next(t); strings.Join(got, " ") != "AUTH default tok3n" {
		t.Fatalf("first command %v", got)
	}
	if got := srv.next(t); got[0] != "PING" {
		t.Fatalf("second command %v", got)
	}

	// Without the CA, the system roots do not know it: the handshake fails
	// and no command (and no token) reaches the server.
	o2, _ := ParseURL("rediss://default:tok3n@" + ln.Addr().String() + "/0")
	c2 := New(o2)
	defer c2.Close()
	if _, err := c2.Do(context.Background(), "PING"); err == nil {
		t.Fatal("a certificate from an unknown CA must be refused")
	}
	select {
	case got := <-srv.commands:
		t.Fatalf("the server received %v from an unverified connection", got)
	case <-time.After(100 * time.Millisecond):
	}
}

func newCA(t *testing.T, name string) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert, key
}

func newLeaf(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey, ip net.IP) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "valkey"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{ip}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, key.Public(), caKey)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}
