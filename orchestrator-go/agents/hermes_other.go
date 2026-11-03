//go:build !unix

package agents

import "os/exec"

// killGroupOnCancel kills only the CLI on cancel outside Unix; the sidecar
// runs on macOS and Linux.
func killGroupOnCancel(cmd *exec.Cmd) {}
