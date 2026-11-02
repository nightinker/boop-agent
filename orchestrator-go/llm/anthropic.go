package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	DefaultAnthropicURL   = "https://api.anthropic.com/v1/messages"
	DefaultAnthropicModel = "claude-opus-5-5"
	anthropicVersion      = "2023-06-01"
	fallbackBeta          = "server-side-fallback-2026-07-01"
)

// Anthropic calls the Claude Messages API over plain HTTP (standard library
// only). The key is read from ANTHROPIC_API_KEY by NewAnthropicFromEnv; it is
// never logged.
type Anthropic struct {
	APIKey    string
	Model     string
	URL       string
	MaxTokens int
	// Effort is output_config.effort ("low".."max"); empty leaves the model default.
	Effort string
	// Fallbacks asks the API to retry a refused request on a fallback model
	// (server-side fallbacks, "default" routing). On by default.
	Fallbacks bool
	Client    *http.Client
}

// NewAnthropicFromEnv builds a provider from ANTHROPIC_API_KEY and the
// optional ORCHESTRATOR_MODEL. It returns an error if no key is set.
func NewAnthropicFromEnv() (*Anthropic, error) {
	key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if key == "" {
		return nil, errors.New("ANTHROPIC_API_KEY is not set")
	}
	a := &Anthropic{APIKey: key, Fallbacks: true}
	if m := strings.TrimSpace(os.Getenv("ORCHESTRATOR_MODEL")); m != "" {
		a.Model = m
	}
	return a, nil
}

type anthropicRequest struct {
	Model        string            `json:"model"`
	MaxTokens    int               `json:"max_tokens"`
	System       string            `json:"system,omitempty"`
	Messages     []Message         `json:"messages"`
	OutputConfig map[string]string `json:"output_config,omitempty"`
	Fallbacks    string            `json:"fallbacks,omitempty"`
}

type anthropicResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// StatusError is a non-2xx answer from the API.
type StatusError struct {
	Status  int
	Message string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("anthropic: HTTP %d: %s", e.Status, e.Message)
}

// Retryable reports whether the request may succeed if sent again.
func (e *StatusError) Retryable() bool {
	return e.Status == 408 || e.Status == 409 || e.Status == 429 || e.Status >= 500
}

// Complete implements LLMProvider.
func (a *Anthropic) Complete(ctx context.Context, req Request) (Response, error) {
	model := a.Model
	if model == "" {
		model = DefaultAnthropicModel
	}
	maxTokens := req.MaxTokens
	if maxTokens == 0 {
		maxTokens = a.MaxTokens
	}
	if maxTokens == 0 {
		maxTokens = 16000
	}
	body := anthropicRequest{Model: model, MaxTokens: maxTokens, System: req.System, Messages: req.Messages}
	if a.Effort != "" {
		body.OutputConfig = map[string]string{"effort": a.Effort}
	}
	if a.Fallbacks {
		body.Fallbacks = "default"
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return Response{}, err
	}
	url := a.URL
	if url == "" {
		url = DefaultAnthropicURL
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return Response{}, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("x-api-key", a.APIKey)
	httpReq.Header.Set("anthropic-version", anthropicVersion)
	if a.Fallbacks {
		httpReq.Header.Set("anthropic-beta", fallbackBeta)
	}
	client := a.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	res, err := client.Do(httpReq)
	if err != nil {
		return Response{}, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return Response{}, err
	}
	var parsed anthropicResponse
	_ = json.Unmarshal(raw, &parsed)
	if res.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(raw))
		if parsed.Error != nil {
			msg = parsed.Error.Message
		}
		if len(msg) > 500 {
			msg = msg[:500]
		}
		return Response{}, &StatusError{Status: res.StatusCode, Message: msg}
	}
	if parsed.StopReason == "refusal" {
		return Response{}, ErrRefused
	}
	var text strings.Builder
	for _, block := range parsed.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	return Response{
		Text:         text.String(),
		InputTokens:  parsed.Usage.InputTokens,
		OutputTokens: parsed.Usage.OutputTokens,
		StopReason:   parsed.StopReason,
	}, nil
}
