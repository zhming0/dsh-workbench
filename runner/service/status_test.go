package service

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
)

func TestSandboxStatusReportsMachineFacts(t *testing.T) {
	response, err := New("box-1").SandboxStatus(context.Background(), connect.NewRequest(&v1.SandboxStatusRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	status := response.Msg
	if status.GetSandboxId() != "box-1" {
		t.Errorf("sandbox id = %q, want box-1", status.GetSandboxId())
	}
	if status.GetUptimeSeconds() < 0 {
		t.Errorf("uptime = %d, want a non-negative number of seconds", status.GetUptimeSeconds())
	}
	if status.GetCpuCount() < 1 {
		t.Errorf("cpu count = %d, want at least one", status.GetCpuCount())
	}
	if status.GetMemoryTotalBytes() <= 0 {
		t.Errorf("memory total = %d, want a positive byte count", status.GetMemoryTotalBytes())
	}
	// The root filesystem is always stat-able, so its total must be real even
	// where the runner image's default workspace is absent.
	if status.GetFilesystemDiskTotalBytes() <= 0 {
		t.Errorf("filesystem disk total = %d, want a positive byte count", status.GetFilesystemDiskTotalBytes())
	}
	if used := status.GetFilesystemDiskUsedBytes(); used < 0 || used > status.GetFilesystemDiskTotalBytes() {
		t.Errorf("filesystem disk used = %d, want a value within the total", used)
	}
}

func TestDiskUsageAnswersForAnExistingDirectory(t *testing.T) {
	used, total := diskUsage(t.TempDir())
	if total <= 0 {
		t.Fatalf("total = %d, want a positive byte count", total)
	}
	if used < 0 || used > total {
		t.Errorf("used = %d, want a value within the total", used)
	}
}

func TestCharsToStringStopsAtTheFirstNUL(t *testing.T) {
	if got := charsToString([]int8{'6', '.', '8', '.', '0', 0, 'x'}); got != "6.8.0" {
		t.Errorf("charsToString = %q, want 6.8.0", got)
	}
	if got := charsToString(nil); got != "" {
		t.Errorf("charsToString of nothing = %q, want empty", got)
	}
}
