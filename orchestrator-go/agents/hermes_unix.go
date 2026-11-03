//go:build unix

package agents

import (
	"os/exec"
	"syscall"
)

// killGroupOnCancel starts the command in its own process group and, on
// cancel, kills the whole group: the CLI, its browser and any shell it ran.
func killGroupOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
}
