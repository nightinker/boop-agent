package llm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBoopComplete(t *testing.T) {
	var got boopCompleteRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/orchestrator/complete" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "" || r.Header.Get("Authorization") != "" {
			t.Error("no credentials should be sent to Boop")
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"text":"merged answer","usage":{"inputTokens":120,"outputTokens":30}}`))
	}))
	defer srv.Close()

	b := (&Boop{BaseURL: srv.URL + "/"}).WithPurpose("merger")
	res, err := b.Complete(context.Background(), Request{
		System:    "sys",
		Messages:  []Message{{Role: "user", Content: "q"}, {Role: "assistant", Content: "a"}, {Role: "user", Content: "fix it"}},
		MaxTokens: 900,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "merged answer" || res.TotalTokens() != 150 {
		t.Fatalf("unexpected response %+v", res)
	}
	if got.System != "sys" || got.MaxTokens != 900 || got.Purpose != "merger" || len(got.Messages) != 3 || got.Messages[2].Content != "fix it" {
		t.Fatalf("unexpected body %+v", got)
	}
}

func TestBoopErrors(t *testing.T) {
	status, body := http.StatusInternalServerError, `{"error":"Claude Code process exited","usage":{"inputTokens":5,"outputTokens":0}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	b := &Boop{BaseURL: srv.URL}
	req := Request{Messages: []Message{{Role: "user", Content: "q"}}}

	res, err := b.Complete(context.Background(), req)
	var se *StatusError
	if !errors.As(err, &se) || !se.Retryable() || res.InputTokens != 5 {
		t.Fatalf("want retryable StatusError with usage, got %v %+v", err, res)
	}

	status, body = http.StatusInternalServerError, `{"error":"usage limit reached","usageLimited":true}`
	if _, err = b.Complete(context.Background(), req); !errors.As(err, &se) || se.Retryable() {
		t.Fatalf("usage limit should not be retryable: %v", err)
	}

	status, body = http.StatusBadRequest, `{"error":"messages are required"}`
	if _, err = b.Complete(context.Background(), req); !errors.As(err, &se) || se.Retryable() {
		t.Fatalf("bad request should not be retryable: %v", err)
	}

	status, body = http.StatusOK, `{"text":"  "}`
	if _, err = b.Complete(context.Background(), req); err == nil {
		t.Fatal("an empty answer should be an error")
	}

	if _, err = (&Boop{}).Complete(context.Background(), req); err == nil {
		t.Fatal("no URL should be an error")
	}
	srv.Close()
	if _, err = b.Complete(context.Background(), req); err == nil {
		t.Fatal("unreachable Boop should be an error")
	}
}
