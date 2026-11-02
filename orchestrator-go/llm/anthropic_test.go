package llm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAnthropicComplete(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "test-key" || r.Header.Get("anthropic-version") == "" {
			t.Errorf("missing headers: %v", r.Header)
		}
		if r.Header.Get("anthropic-beta") != fallbackBeta {
			t.Errorf("anthropic-beta = %q", r.Header.Get("anthropic-beta"))
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"hi "},{"type":"text","text":"there"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":3}}`))
	}))
	defer srv.Close()

	a := &Anthropic{APIKey: "test-key", URL: srv.URL, Fallbacks: true}
	res, err := a.Complete(context.Background(), Request{System: "sys", Messages: []Message{{Role: "user", Content: "q"}}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "hi there" || res.TotalTokens() != 13 {
		t.Fatalf("unexpected response %+v", res)
	}
	if got["model"] != DefaultAnthropicModel || got["system"] != "sys" || got["fallbacks"] != "default" {
		t.Fatalf("unexpected body %v", got)
	}
}

func TestAnthropicErrors(t *testing.T) {
	status := http.StatusTooManyRequests
	body := `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	a := &Anthropic{APIKey: "k", URL: srv.URL}

	_, err := a.Complete(context.Background(), Request{Messages: []Message{{Role: "user", Content: "q"}}})
	var se *StatusError
	if !errors.As(err, &se) || !se.Retryable() || se.Message != "slow down" {
		t.Fatalf("want retryable StatusError, got %v", err)
	}

	status, body = 200, `{"content":[],"stop_reason":"refusal","usage":{}}`
	_, err = a.Complete(context.Background(), Request{Messages: []Message{{Role: "user", Content: "q"}}})
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("want ErrRefused, got %v", err)
	}
}

func TestMockScript(t *testing.T) {
	m := &Mock{Replies: []MockReply{{Text: "a"}, {Err: errors.New("boom")}}}
	if r, _ := m.Complete(context.Background(), Request{}); r.Text != "a" {
		t.Fatal("first reply")
	}
	for i := 0; i < 2; i++ {
		if _, err := m.Complete(context.Background(), Request{}); err == nil {
			t.Fatal("want repeated error")
		}
	}
	if len(m.Calls()) != 3 {
		t.Fatal("calls not recorded")
	}
}
