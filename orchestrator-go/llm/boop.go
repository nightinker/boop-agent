package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Boop runs a completion through Boop's own model runtime (the Claude Agent
// SDK, signed in with the Claude account already logged in on the Mac) via
// POST /orchestrator/complete on Boop's server. No API key is involved; Boop
// answers with the text and the tokens the call used.
type Boop struct {
	BaseURL string       // e.g. http://127.0.0.1:3456
	Client  *http.Client // should have no short timeout; a merge can take a minute or two
	// Purpose labels the call in Boop's usage records ("planner", "merger", "llm-agent").
	Purpose string
}

type boopCompleteRequest struct {
	System    string    `json:"system,omitempty"`
	Messages  []Message `json:"messages"`
	MaxTokens int       `json:"max_tokens,omitempty"`
	Purpose   string    `json:"purpose,omitempty"`
}

type boopCompleteResponse struct {
	Text         string `json:"text"`
	Error        string `json:"error"`
	UsageLimited bool   `json:"usageLimited"`
	Usage        *struct {
		InputTokens  int `json:"inputTokens"`
		OutputTokens int `json:"outputTokens"`
	} `json:"usage"`
}

// WithPurpose returns a copy of b that labels its calls with purpose.
func (b *Boop) WithPurpose(purpose string) *Boop {
	c := *b
	c.Purpose = purpose
	return &c
}

// Complete implements LLMProvider.
func (b *Boop) Complete(ctx context.Context, req Request) (Response, error) {
	base := strings.TrimRight(b.BaseURL, "/")
	if base == "" {
		return Response{}, fmt.Errorf("boop llm: no Boop URL")
	}
	buf, err := json.Marshal(boopCompleteRequest{System: req.System, Messages: req.Messages, MaxTokens: req.MaxTokens, Purpose: b.Purpose})
	if err != nil {
		return Response{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/orchestrator/complete", bytes.NewReader(buf))
	if err != nil {
		return Response{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	client := b.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return Response{}, ctx.Err()
		}
		return Response{}, fmt.Errorf("reaching Boop: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		if ctx.Err() != nil {
			return Response{}, ctx.Err()
		}
		return Response{}, fmt.Errorf("reading Boop's answer: %w", err)
	}
	var parsed boopCompleteResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return Response{}, &StatusError{Status: res.StatusCode, Message: fmt.Sprintf("Boop answered with non-JSON: %.200s", raw)}
	}
	out := Response{Text: parsed.Text, StopReason: "end_turn"}
	if parsed.Usage != nil {
		out.InputTokens = max(parsed.Usage.InputTokens, 0)
		out.OutputTokens = max(parsed.Usage.OutputTokens, 0)
	}
	if res.StatusCode/100 != 2 {
		msg := strings.TrimSpace(parsed.Error)
		if msg == "" {
			msg = "no details"
		}
		status := res.StatusCode
		if parsed.UsageLimited && status >= 500 {
			// The account's usage limit: retrying now just fails again.
			status = http.StatusPaymentRequired
		}
		return out, &StatusError{Status: status, Message: "boop: " + msg}
	}
	if strings.TrimSpace(out.Text) == "" {
		return out, fmt.Errorf("boop llm: empty answer")
	}
	return out, nil
}
