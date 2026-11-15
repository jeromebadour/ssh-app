package link

import (
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// ShellOptions say how a tab's shell starts.
type ShellOptions struct {
	// Folder is the place's folder. Empty asks the box for a plain shell. It comes only from the saved place,
	// never from anything a box sent (plan B2.5).
	Folder     string
	Term       string // the terminal type; the one thing about this side a box is told
	Cols, Rows int
}

// ErrFolderName is returned for a folder whose name cannot be put in a command safely.
var ErrFolderName = errors.New("link: the folder's name holds a control character and is never put in a command")

// StartCommand is the one command the app gives a box when a place opens (plan B2.5, line 1): go to the folder,
// then become the user's own login shell. It is the session's start command, not something typed. Empty for
// no folder. The folder is quoted so that no character in it can be read as anything but part of the name.
func StartCommand(folder string) (string, error) {
	if folder == "" {
		return "", nil
	}
	for _, r := range folder {
		if r < 0x20 || r == 0x7f {
			return "", ErrFolderName
		}
	}
	return "cd -- '" + strings.ReplaceAll(folder, "'", `'\''`) + `' && exec "$SHELL" -l`, nil
}

// Shell is a tab's terminal session on the box.
type Shell struct {
	ch     ssh.Channel
	mu     sync.Mutex
	status *int
	exited chan struct{}
}

// OpenShell starts the tab's shell: a terminal of the given size, then either the start command for the
// folder or a plain shell. Nothing else is sent, and nothing is ever typed into it by the app.
func (l *Link) OpenShell(opt ShellOptions) (*Shell, error) {
	cmd, err := StartCommand(opt.Folder)
	if err != nil {
		return nil, err
	}
	if opt.Term == "" || opt.Cols <= 0 || opt.Rows <= 0 || opt.Cols > 2000 || opt.Rows > 2000 {
		return nil, errors.New("link: a shell needs a terminal type and a sane size")
	}
	ch, reqs, err := l.conn.OpenChannel("session", nil)
	if err != nil {
		return nil, err
	}
	s := &Shell{ch: ch, exited: make(chan struct{})}
	go s.requests(reqs)

	pty := ssh.Marshal(struct {
		Term                   string
		Cols, Rows, Wide, High uint32
		Modes                  string
	}{opt.Term, uint32(opt.Cols), uint32(opt.Rows), 0, 0, "\x00"})
	if ok, err := ch.SendRequest("pty-req", true, pty); err != nil || !ok {
		_ = ch.Close()
		return nil, refusal("a terminal", err)
	}
	if cmd == "" {
		if ok, err := ch.SendRequest("shell", true, nil); err != nil || !ok {
			_ = ch.Close()
			return nil, refusal("a shell", err)
		}
	} else if ok, err := ch.SendRequest("exec", true, ssh.Marshal(struct{ Command string }{cmd})); err != nil || !ok {
		_ = ch.Close()
		return nil, refusal("the place's shell", err)
	}
	return s, nil
}

func refusal(what string, err error) error {
	if err != nil {
		return errors.New("link: asking the box for " + what + ": " + err.Error())
	}
	return errors.New("link: the box refused " + what)
}

// requests reads what the box says about the session; the only thing kept is how the shell exited.
func (s *Shell) requests(reqs <-chan *ssh.Request) {
	for r := range reqs {
		if r.Type == "exit-status" && len(r.Payload) == 4 {
			code := int(r.Payload[0])<<24 | int(r.Payload[1])<<16 | int(r.Payload[2])<<8 | int(r.Payload[3])
			s.mu.Lock()
			s.status = &code
			s.mu.Unlock()
		}
		if r.WantReply {
			_ = r.Reply(false, nil)
		}
	}
	close(s.exited)
}

// Read gives what the box printed. With a terminal, a box sends everything on one stream.
func (s *Shell) Read(p []byte) (int, error) { return s.ch.Read(p) }

// Write sends typed bytes, exactly as given.
func (s *Shell) Write(p []byte) (int, error) { return s.ch.Write(p) }

// Resize tells the box the terminal's new size.
func (s *Shell) Resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 || cols > 2000 || rows > 2000 {
		return errors.New("link: not a sane terminal size")
	}
	_, err := s.ch.SendRequest("window-change", false, ssh.Marshal(struct{ Cols, Rows, Wide, High uint32 }{uint32(cols), uint32(rows), 0, 0}))
	return err
}

// Exited is closed when the session is over; ExitStatus then says how, if the box said.
func (s *Shell) Exited() <-chan struct{} { return s.exited }

// ExitStatus is the shell's exit code. False if the session ended without one (the link went, or a signal).
func (s *Shell) ExitStatus() (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status == nil {
		return 0, false
	}
	return *s.status, true
}

// Close ends the session from our side.
func (s *Shell) Close() { _ = s.ch.Close() }

var _ io.ReadWriter = (*Shell)(nil)

// Pulse is what the keepalive last learned about the link.
type Pulse struct {
	Silent    bool          // an answer is late; the link is kept
	Since     time.Time     // Silent: when the unanswered keepalive was sent
	RoundTrip time.Duration // not Silent: how long the last answer took
}

// Watch measures the link for as long as it lives (plan B8): one small request every interval, answered by
// any SSH server. An answer gives the round trip. An answer that is late by more than `late` is reported as
// silence, once, with the moment it began; no further request is stacked behind it; when the answer does come,
// that is reported too. Watch never ends the link: what ends a silent link is the operating system's patience,
// or the person at the keyboard.
func (l *Link) Watch(interval, late time.Duration, report func(Pulse)) {
	go func() {
		for {
			sent := time.Now()
			answered := make(chan error, 1)
			go func() {
				_, _, err := l.conn.SendRequest("keepalive@openssh.com", true, nil)
				answered <- err
			}()
			lateTimer := time.NewTimer(late)
			var err error
			select {
			case err = <-answered:
				lateTimer.Stop()
			case <-lateTimer.C:
				report(Pulse{Silent: true, Since: sent})
				select {
				case err = <-answered:
				case <-l.done:
					return
				}
			case <-l.done:
				lateTimer.Stop()
				return
			}
			if err != nil {
				return // the link is gone; Done and End say why
			}
			report(Pulse{RoundTrip: time.Since(sent)})
			select {
			case <-time.After(interval):
			case <-l.done:
				return
			}
		}
	}()
}
