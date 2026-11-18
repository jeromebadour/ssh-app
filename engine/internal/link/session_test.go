package link

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"sshapp/engine/internal/lab/faultproxy"
	"sshapp/engine/internal/lab/hostile"
)

func up(t *testing.T, w *world) *Link {
	t.Helper()
	l, err := Dial(context.Background(), w.target, w.user, Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	return l
}

func withSessions(c *hostile.Config) { c.Sessions = true }

func TestStartCommand(t *testing.T) {
	for folder, want := range map[string]string{
		"":                   "",
		"/srv/app":           `cd -- '/srv/app' && exec "$SHELL" -l`,
		"/srv/my app":        `cd -- '/srv/my app' && exec "$SHELL" -l`,
		"/srv/it's":          `cd -- '/srv/it'\''s' && exec "$SHELL" -l`,
		"/srv/$(reboot)":     `cd -- '/srv/$(reboot)' && exec "$SHELL" -l`,
		"/srv/`id`;x&&y|z>w": "cd -- '/srv/`id`;x&&y|z>w' && exec \"$SHELL\" -l",
		"-rf":                `cd -- '-rf' && exec "$SHELL" -l`,
		"/srv/''; reboot; '": `cd -- '/srv/'\'''\''; reboot; '\''' && exec "$SHELL" -l`,
		"/srv/naïve/日本":      `cd -- '/srv/naïve/日本' && exec "$SHELL" -l`,
	} {
		got, err := StartCommand(folder)
		if err != nil || got != want {
			t.Errorf("%q: %q %v; wanted %q", folder, got, err, want)
		}
	}
	for _, folder := range []string{"/srv/a\nreboot", "/srv/a\rb", "/srv/\x1b[2J", "/srv/a\x00b", "/srv/a\tb", "/srv/a\x7f"} {
		if _, err := StartCommand(folder); !errors.Is(err, ErrFolderName) {
			t.Errorf("%q was accepted: %v", folder, err)
		}
	}
}

// A tmux place is asked for exactly the one command of plan B2.5 line 2, and nothing more: this app's own
// tmux server by its own socket, no config file of his read or written, and the place's session attached when
// it is already there, which is what keeps a job alive through a link that is truly gone.
func TestATmuxPlaceIsAskedExactlyThis(t *testing.T) {
	w := setup(t, withSessions)
	l := up(t, w)
	if _, err := l.OpenShell(ShellOptions{Folder: "/srv/it's here", Tmux: "build", Term: "xterm-256color", Cols: 120, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	got := w.box.Sessions()
	if len(got) != 1 {
		t.Fatalf("%d sessions", len(got))
	}
	want := `tmux -L berth -f /dev/null has-session -t 'build' 2>/dev/null || cd -- '/srv/it'\''s here' || exit 2; exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'build'`
	if len(got[0].Asked) != 2 || got[0].Asked[0] != "pty-req" || got[0].Asked[1] != "exec" || got[0].Command != want {
		t.Fatalf("asked %v, command %q; want %q", got[0].Asked, got[0].Command, want)
	}
}

// A name tmux would not leave alone never reaches a box: the window holds the same rule, and this is the
// last place it can be held.
func TestATmuxNameThatIsNotOneNeverReachesABox(t *testing.T) {
	w := setup(t, withSessions)
	l := up(t, w)
	for _, bad := range []string{"a b", "a.b", "a:b", "a;reboot", "a'b", "../x", string(make([]byte, 33))} {
		if _, err := l.OpenShell(ShellOptions{Folder: "/srv", Tmux: bad, Term: "xterm", Cols: 80, Rows: 24}); !errors.Is(err, ErrTmuxName) {
			t.Fatalf("OpenShell took the name %q: %v", bad, err)
		}
	}
	time.Sleep(50 * time.Millisecond)
	if got := w.box.Sessions(); len(got) != 0 {
		t.Fatalf("%d sessions were opened for names that are not names", len(got))
	}
}

// What a box is asked when a place opens is exactly this and nothing more (plan B2.5, B10): a terminal, then
// the one start command. And for a tab with no place: a terminal, then a plain shell.
func TestABoxIsAskedExactlyThis(t *testing.T) {
	w := setup(t, withSessions)
	l := up(t, w)
	if _, err := l.OpenShell(ShellOptions{Folder: "/srv/it's here", Term: "xterm-256color", Cols: 120, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	if _, err := l.OpenShell(ShellOptions{Term: "xterm-256color", Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	got := w.box.Sessions()
	if len(got) != 2 {
		t.Fatalf("%d sessions", len(got))
	}
	a, b := got[0], got[1]
	if len(a.Asked) != 2 || a.Asked[0] != "pty-req" || a.Asked[1] != "exec" || a.Command != `cd -- '/srv/it'\''s here' && exec "$SHELL" -l` || a.Term != "xterm-256color" || a.Cols != 120 || a.Rows != 40 {
		t.Fatalf("a place: %+v", a)
	}
	if len(b.Asked) != 2 || b.Asked[0] != "pty-req" || b.Asked[1] != "shell" || b.Command != "" || b.Cols != 80 || b.Rows != 24 {
		t.Fatalf("no place: %+v", b)
	}
}

func TestAFolderThatCannotBeQuotedOpensNothing(t *testing.T) {
	w := setup(t, withSessions)
	l := up(t, w)
	if _, err := l.OpenShell(ShellOptions{Folder: "/srv/a\nreboot", Term: "xterm", Cols: 80, Rows: 24}); !errors.Is(err, ErrFolderName) {
		t.Fatal(err)
	}
	if _, err := l.OpenShell(ShellOptions{Term: "", Cols: 80, Rows: 24}); err == nil {
		t.Fatal("a shell with no terminal type")
	}
	if _, err := l.OpenShell(ShellOptions{Term: "xterm", Cols: 0, Rows: 24}); err == nil {
		t.Fatal("a shell with no width")
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(w.box.Sessions()); n != 0 {
		t.Fatalf("the box was asked for %d sessions", n)
	}
}

// Typed bytes arrive exactly, in order, whatever they are; what the box prints comes back exactly.
func TestBytesBothWaysAreExact(t *testing.T) {
	w := setup(t, withSessions)
	l := up(t, w)
	s, err := l.OpenShell(ShellOptions{Term: "xterm", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 1<<20)
	_, _ = rand.Read(data)
	go func() { _, _ = s.Write(data) }()
	got := make([]byte, len(data))
	done := make(chan error, 1)
	go func() { _, err := io.ReadFull(s, got); done <- err }()
	select {
	case err := <-done:
		if err != nil || !bytes.Equal(got, data) {
			t.Fatalf("1 MiB did not come back the same: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("1 MiB did not come back")
	}
}

func TestResizeAndExit(t *testing.T) {
	w := setup(t, withSessions)
	l := up(t, w)
	s, err := l.OpenShell(ShellOptions{Term: "xterm", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Resize(132, 50); err != nil {
		t.Fatal(err)
	}
	if err := s.Resize(0, 50); err == nil {
		t.Fatal("a width of nothing was sent")
	}
	if _, ok := s.ExitStatus(); ok {
		t.Fatal("an exit status before the shell ended")
	}
	_, _ = s.Write([]byte("exit\n"))
	select {
	case <-s.Exited():
	case <-time.After(5 * time.Second):
		t.Fatal("the shell did not end")
	}
	if code, ok := s.ExitStatus(); !ok || code != 7 {
		t.Fatalf("exit status %d %v", code, ok)
	}
	got := w.box.Sessions()[0]
	if len(got.Resizes) != 1 || got.Resizes[0] != [2]uint32{132, 50} {
		t.Fatalf("resizes: %v", got.Resizes)
	}
	select {
	case <-l.Done():
		t.Fatal("the link ended with the shell")
	case <-time.After(50 * time.Millisecond):
	}
}

// The keepalive: a round trip while the link answers; silence said once, with when it began, when an answer
// is late; the answer said when it comes; and the link never ended by any of it.
func TestWatch(t *testing.T) {
	w := setup(t, nil)
	p, err := faultproxy.Listen(w.box.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	w.target.Addr = p.Addr()
	l := up(t, w)

	var mu sync.Mutex
	var pulses []Pulse
	l.Watch(50*time.Millisecond, 300*time.Millisecond, func(x Pulse) { mu.Lock(); pulses = append(pulses, x); mu.Unlock() })
	snapshot := func() []Pulse { mu.Lock(); defer mu.Unlock(); return append([]Pulse(nil), pulses...) }
	waitFor := func(what string, ok func([]Pulse) bool) []Pulse {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
			if got := snapshot(); ok(got) {
				return got
			}
		}
		t.Fatalf("waited 5 s for %s; got %+v", what, snapshot())
		return nil
	}

	got := waitFor("three answers", func(x []Pulse) bool { return len(x) >= 3 })
	for _, x := range got {
		if x.Silent || x.RoundTrip < 0 || x.RoundTrip > 250*time.Millisecond { // zero is a real answer: faster than the clock ticks (seen on Windows)
			t.Fatalf("on a good link: %+v", x)
		}
	}

	p.Set(faultproxy.Faults{Hold: true})
	held := time.Now()
	got = waitFor("silence to be said", func(x []Pulse) bool { return x[len(x)-1].Silent })
	if since := got[len(got)-1].Since; since.Before(held.Add(-200*time.Millisecond)) || since.After(time.Now()) {
		t.Fatalf("silence began at %v; the link was held at %v", since, held)
	}
	said := len(got)
	time.Sleep(time.Second)
	if n := len(snapshot()); n != said {
		t.Fatalf("during the silence %d more reports came; it is said once and nothing is stacked", n-said)
	}
	select {
	case <-l.Done():
		t.Fatalf("the silent link was ended: %v", l.End())
	default:
	}

	p.Set(faultproxy.Faults{})
	got = waitFor("the answer after the silence", func(x []Pulse) bool { return len(x) > said && !x[len(x)-1].Silent })
	if back := got[said]; back.Silent || back.RoundTrip < time.Second {
		t.Fatalf("the late answer was reported as %+v", back)
	}
	waitFor("normal answers again", func(x []Pulse) bool { return len(x) >= said+3 && x[len(x)-1].RoundTrip < 250*time.Millisecond })

	l.Close()
	<-l.Done()
	n := len(snapshot())
	time.Sleep(300 * time.Millisecond)
	if len(snapshot()) != n {
		t.Fatal("the watch went on after the link ended")
	}
}

// A reset while bytes are moving both ways is still said as a reset. The operating system reports it once, to
// the library's writer or its reader, whichever asks first; reading the library's own verdict called a fair
// share of these "the box closed the connection" (found by the engine's tests, 2026-11-16).
func TestAResetOnABusyLinkIsStillAReset(t *testing.T) {
	for i := 0; i < 60; i++ {
		w := setup(t, withSessions)
		p, err := faultproxy.Listen(w.box.Addr())
		if err != nil {
			t.Fatal(err)
		}
		w.target.Addr = p.Addr()
		l := up(t, w)
		s, err := l.OpenShell(ShellOptions{Term: "xterm", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		go func() { _, _ = io.Copy(io.Discard, s) }()
		go func() {
			buf := make([]byte, 4096)
			for {
				if _, err := s.Write(buf); err != nil {
					return
				}
			}
		}()
		time.Sleep(3 * time.Millisecond)
		p.Reset()
		select {
		case <-l.Done():
			if l.End().Cause != Reset {
				t.Fatalf("round %d: a reset on a busy link was said as %v", i, l.End())
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("round %d: the link did not end", i)
		}
		p.Close()
		w.box.Close()
	}
}
