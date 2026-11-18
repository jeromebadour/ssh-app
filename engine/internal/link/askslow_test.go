package link

import (
	"context"
	"net"
	"testing"
	"time"

	"sshapp/engine/internal/lab/hostile"
)

// A person reading a code off a phone is slow, and the engine allows three minutes for it (askWait in the
// first visit's own program). This asks whether the link survives that wait at all: the phase this app is in
// while a box's questions are being answered has a deadline of its own, and if that deadline is still
// running the wait it allows is the phase's, not the three minutes.
//
// The deadlines are made short here so the probe takes a second rather than twenty: the question is whether
// the phase's deadline ends the sign-in while the person is typing, and that is the same question at two
// seconds as at twenty.
func TestABoxsQuestionsMayBeAnsweredSlowly(t *testing.T) {
	w := setup(t, func(c *hostile.Config) {
		c.Sessions = true
		c.Asks = [][]string{{"Verification code:"}}
		c.Shown = [][]bool{{false}}
		c.Answers = [][]string{{"123456"}}
	})
	w.box.AnswerCommandsWith("visited\n")
	const phase = 2 * time.Second
	slow := phase + time.Second // longer than the phase's deadline, far shorter than the three minutes
	said, e := FirstVisit(context.Background(), w.target, "the password", "echo visited", Options{
		Deadlines: Deadlines{Connect: phase, KeyExchange: phase, SignIn: phase},
		OnAsk: func(questions []string, show []bool) ([]string, error) {
			time.Sleep(slow)
			return []string{"123456"}, nil
		},
	})
	if e != nil {
		t.Fatalf("a question answered after %s ended the visit: %v (the phase's deadline is %s; the first visit's program allows three minutes for an answer)", slow, e, phase)
	}
	if said == "" {
		t.Fatal("the box said nothing back")
	}
}

// The two halves of holding a deadline off, on their own: while a person is being asked nothing ends the
// attempt however long they take, and the moment they have answered the deadline is running again. Without
// the second half a box could ask once and then keep the sign-in open for ever.
func TestAHeldDeadlineWaitsForThePersonAndThenRuns(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			defer c.Close()
		}
	}()
	dial, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	a := &attempt{conn: dial.(*net.TCPConn), phase: KeyExchange}
	a.enter(KeyExchange, 40*time.Millisecond)
	a.asking(SigningIn)
	time.Sleep(160 * time.Millisecond) // four times the deadline, with a person still typing
	a.mu.Lock()
	ended, phase := a.ended, a.phase
	a.mu.Unlock()
	if ended != "" {
		t.Fatalf("the attempt ended while the person was answering: %q", ended)
	}
	if phase != SigningIn {
		t.Fatalf("the phase while answering must be the one that is happening: %q", phase)
	}
	a.answered(40 * time.Millisecond)
	time.Sleep(160 * time.Millisecond)
	a.mu.Lock()
	ended, in := a.ended, a.endedIn
	a.mu.Unlock()
	if ended != TimedOut || in != SigningIn {
		t.Fatalf("after the answer the deadline must run again: ended %q in %q", ended, in)
	}
}
