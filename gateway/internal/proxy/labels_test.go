package proxy

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestParseLabels(t *testing.T) {
	for _, c := range []struct {
		in   []string
		want []string
		ok   bool
	}{
		{nil, nil, true},
		{[]string{""}, nil, true},
		{[]string{"topic_legal"}, []string{"topic_legal"}, true},
		{[]string{" topic_legal , eval_warned,topic_legal"}, []string{"eval_warned", "topic_legal"}, true},
		{[]string{"a", "b,c"}, []string{"a", "b", "c"}, true},
		{[]string{"Topic"}, nil, false},
		{[]string{"topic-legal"}, nil, false},
		{[]string{"tópico"}, nil, false},
		{[]string{strings.Repeat("x", 41)}, nil, false},
		{[]string{"a,b,c,d,e,f,g,h,i"}, nil, false},
		{[]string{"a,b,c,d,e,f,g,h,a"}, []string{"a", "b", "c", "d", "e", "f", "g", "h"}, true},
	} {
		got, ok := parseLabels(c.in)
		if ok != c.ok || !slices.Equal(got, c.want) {
			t.Errorf("%q: %v %v, want %v %v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestLabelsReachTheUsageRecord(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	send := func(labels string) int {
		req, _ := http.NewRequest(http.MethodPost, e.gw.URL+"/v1/chat/completions",
			strings.NewReader(`{"model":"openai/gpt-4o","messages":[]}`))
		req.Header.Set("Authorization", "Bearer "+devKey)
		req.Header.Set("X-Stratum-Labels", labels)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := send("topic_legal, eval_warned"); code != 200 {
		t.Fatalf("labelled request: %d", code)
	}
	if code := send("Topic Legal"); code != 400 {
		t.Fatalf("malformed labels: %d", code)
	}
	got := e.usage.wait(t, 2)
	if len(got) != 2 {
		t.Fatalf("%d records", len(got))
	}
	if !slices.Equal(got[0].Labels, []string{"eval_warned", "topic_legal"}) || len(got[0].ContentFlags) != 0 {
		t.Errorf("labels %v, content flags %v", got[0].Labels, got[0].ContentFlags)
	}
	if got[1].Reason != "invalid_labels" || got[1].Labels != nil {
		t.Errorf("refused: %+v", got[1])
	}
}
