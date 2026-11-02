// Package llm is the orchestrator's narrow view of a language model: one
// request in, one text answer out. Providers: Anthropic (real) and Mock (tests).
package llm

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// Message is one turn of a conversation. Role is "user" or "assistant".
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Request is a single completion request.
type Request struct {
	System    string
	Messages  []Message
	MaxTokens int // 0 means the provider default
}

// Response is the provider's answer and what it cost in tokens.
type Response struct {
	Text         string
	InputTokens  int
	OutputTokens int
	StopReason   string
}

// TotalTokens is input plus output tokens.
func (r Response) TotalTokens() int { return r.InputTokens + r.OutputTokens }

// LLMProvider is implemented by every model backend.
type LLMProvider interface {
	Complete(ctx context.Context, req Request) (Response, error)
}

// ErrRefused means the model declined the request; retrying won't help.
var ErrRefused = errors.New("llm: model refused the request")

// Mock is a scripted LLMProvider for tests. Each call pops the next reply (or
// error) in order; when the script runs out it repeats the last one. If Fn is
// set it is used instead of the script. Safe for concurrent use.
type Mock struct {
	mu      sync.Mutex
	Replies []MockReply
	Fn      func(ctx context.Context, req Request) (Response, error)
	calls   []Request
}

// MockReply is one scripted answer.
type MockReply struct {
	Text string
	Err  error
	// Tokens is reported as output tokens; defaults to len(Text)/4+1.
	Tokens int
}

// Complete implements LLMProvider.
func (m *Mock) Complete(ctx context.Context, req Request) (Response, error) {
	m.mu.Lock()
	m.calls = append(m.calls, req)
	fn := m.Fn
	var reply MockReply
	n := len(m.calls)
	if fn == nil {
		if len(m.Replies) == 0 {
			m.mu.Unlock()
			return Response{}, fmt.Errorf("llm.Mock: no replies scripted")
		}
		i := n - 1
		if i >= len(m.Replies) {
			i = len(m.Replies) - 1
		}
		reply = m.Replies[i]
	}
	m.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	if fn != nil {
		return fn(ctx, req)
	}
	if reply.Err != nil {
		return Response{}, reply.Err
	}
	tokens := reply.Tokens
	if tokens == 0 {
		tokens = len(reply.Text)/4 + 1
	}
	return Response{Text: reply.Text, OutputTokens: tokens, StopReason: "end_turn"}, nil
}

// Calls returns a copy of every request received so far.
func (m *Mock) Calls() []Request {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Request(nil), m.calls...)
}
