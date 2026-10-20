package proxy

import (
	"slices"
	"strings"
)

// maxLabels is the most labels a request may carry; the control plane
// stores no more.
const maxLabels = 8

// parseLabels reads X-Stratum-Labels: comma-separated labels of lowercase
// letters, digits and underscores, 1 to 40 characters each, in one header
// or several. Duplicates are dropped and the rest sorted. ok is false when
// any label is malformed or there are more than maxLabels: a typo in a
// label must not go unnoticed and leave reports quietly wrong.
func parseLabels(values []string) (labels []string, ok bool) {
	for _, v := range values {
		for _, l := range strings.Split(v, ",") {
			l = strings.TrimSpace(l)
			if l == "" {
				continue
			}
			if !validLabel(l) {
				return nil, false
			}
			labels = append(labels, l)
		}
	}
	slices.Sort(labels)
	labels = slices.Compact(labels)
	if len(labels) > maxLabels {
		return nil, false
	}
	return labels, true
}

func validLabel(l string) bool {
	if len(l) > 40 {
		return false
	}
	for _, c := range l {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}
