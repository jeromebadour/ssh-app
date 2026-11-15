package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"sshapp/engine/internal/frame"
)

var bin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "sshapp-engine-test")
	if err != nil {
		panic(err)
	}
	bin = filepath.Join(dir, "engine")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type proc struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	out *bufio.Reader
}

func start(t *testing.T) *proc {
	t.Helper()
	cmd := exec.Command(bin)
	in, _ := cmd.StdinPipe()
	outPipe, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &proc{cmd: cmd, in: in, out: bufio.NewReader(outPipe)}
	t.Cleanup(func() { in.Close(); cmd.Process.Kill(); cmd.Wait() })
	return p
}

func (p *proc) send(t *testing.T, typ byte, body []byte) {
	t.Helper()
	buf, err := frame.Append(nil, typ, body)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.in.Write(buf); err != nil {
		t.Fatal(err)
	}
}

func (p *proc) read(t *testing.T) frame.Frame {
	t.Helper()
	type res struct {
		f   frame.Frame
		err error
	}
	ch := make(chan res, 1)
	go func() { f, err := frame.Read(p.out); ch <- res{f, err} }()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("read: %v", r.err)
		}
		return r.f
	case <-time.After(5 * time.Second):
		t.Fatal("no frame within 5 s")
		return frame.Frame{}
	}
}

func (p *proc) exit(t *testing.T) int {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			return 0
		}
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("the engine did not exit within 5 s")
	}
	return -1
}

func aimed(t *testing.T) *proc {
	p := start(t)
	p.send(t, frame.TypeAim, []byte(`{"v":1,"tab":"7","stub":true}`))
	h := p.read(t)
	var hello map[string]any
	if h.Type != frame.TypeHello || json.Unmarshal(h.Body, &hello) != nil || hello["tab"] != "7" {
		t.Fatalf("want Hello for tab 7, got type %#x %s", h.Type, h.Body)
	}
	return p
}

func TestHelloPingEcho(t *testing.T) {
	p := aimed(t)
	p.send(t, frame.TypePing, []byte("12345678"))
	if f := p.read(t); f.Type != frame.TypePong || string(f.Body) != "12345678" {
		t.Fatalf("want Pong with the same body, got %#x %q", f.Type, f.Body)
	}
	raw := []byte{0, 3, 27, 255, 'a', '\r', '\n'}
	p.send(t, frame.TypeInput, raw)
	if f := p.read(t); f.Type != frame.TypeOutput || !bytes.Equal(f.Body, raw) {
		t.Fatalf("want the same bytes back, got %#x %x", f.Type, f.Body)
	}
}

func TestExitsWhenParentIsGone(t *testing.T) {
	p := aimed(t)
	p.in.Close()
	if code := p.exit(t); code != exitOK {
		t.Fatalf("exit code %d, want %d", code, exitOK)
	}
}

func TestStaysWhileParentIsSilent(t *testing.T) {
	p := aimed(t)
	time.Sleep(1500 * time.Millisecond) // no ping, no input: silence is not a reason to end
	p.send(t, frame.TypePing, []byte("still on"))
	if f := p.read(t); f.Type != frame.TypePong {
		t.Fatalf("the engine did not survive a silent parent, got %#x", f.Type)
	}
}

func TestAimedOnce(t *testing.T) {
	p := aimed(t)
	p.send(t, frame.TypeAim, []byte(`{"v":1,"tab":"8","stub":true}`))
	if f := p.read(t); f.Type != frame.TypeFatal {
		t.Fatalf("a second Aim must be fatal, got %#x", f.Type)
	}
	if code := p.exit(t); code != exitBadFrame {
		t.Fatalf("exit code %d, want %d", code, exitBadFrame)
	}
}

func TestFirstFrameMustBeAim(t *testing.T) {
	p := start(t)
	p.send(t, frame.TypeInput, []byte("x"))
	if f := p.read(t); f.Type != frame.TypeFatal {
		t.Fatalf("want Fatal, got %#x", f.Type)
	}
	if code := p.exit(t); code != exitNoAim {
		t.Fatalf("exit code %d, want %d", code, exitNoAim)
	}
}

func TestMalformedFrameEndsIt(t *testing.T) {
	for name, bad := range map[string][]byte{
		"zero length":  {0, 0, 0, 0},
		"over limit":   {0xff, 0xff, 0xff, 0xff},
		"unknown type": {0, 0, 0, 1, 0x55},
	} {
		p := aimed(t)
		if _, err := p.in.Write(bad); err != nil {
			t.Fatal(err)
		}
		if f := p.read(t); f.Type != frame.TypeFatal {
			t.Fatalf("%s: want Fatal, got %#x", name, f.Type)
		}
		if code := p.exit(t); code != exitBadFrame {
			t.Fatalf("%s: exit code %d, want %d", name, code, exitBadFrame)
		}
	}
}
