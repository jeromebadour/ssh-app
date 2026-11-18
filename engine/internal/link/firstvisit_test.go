package link

import (
	"context"
	"errors"
	"strings"
	"testing"

	"sshapp/engine/internal/lab/hostile"
)

// The first visit is the one place this app ever offers a password, so what it refuses matters more than what
// it does. These are the refusals that have to hold whatever else changes.
func TestFirstVisitRefusesWhatItMust(t *testing.T) {
	key := edKey(t).PublicKey()
	whole := Target{Addr: "198.51.100.9:22", User: "deploy", HostKey: key}

	for _, c := range []struct {
		what     string
		target   Target
		password string
		command  string
	}{
		{"no pinned identity", Target{Addr: whole.Addr, User: whole.User}, "a password", "true"},
		{"no user", Target{Addr: whole.Addr, HostKey: key}, "a password", "true"},
		{"no address", Target{User: whole.User, HostKey: key}, "a password", "true"},
		{"no password", whole, "", "true"},
		{"nothing to run", whole, "a password", ""},
	} {
		said, e := FirstVisit(context.Background(), c.target, c.password, c.command, Options{})
		if e == nil {
			t.Fatalf("%s: it went ahead; it must not", c.what)
		}
		if said != "" {
			t.Fatalf("%s: it said %q; nothing should have been said", c.what, said)
		}
		// None of these may ever reach the network: each is refused before anything is opened.
		if e.Phase != Connecting && e.Phase != SigningIn {
			t.Fatalf("%s: refused at %q, which is not where it is refused", c.what, e.Phase)
		}
	}
}

// What a box prints back is a box's own words, and a box can print without end. It is capped, so a short
// command cannot be answered with a stream that fills this app's memory.
func TestWhatABoxPrintsBackIsCapped(t *testing.T) {
	var said strings.Builder
	w := &capped{to: &said, left: 10}
	n, err := w.Write([]byte("0123456789abcdef"))
	if err != nil || n != 16 {
		t.Fatalf("a write that is cut must still say it took everything: %d, %v", n, err)
	}
	n, err = w.Write([]byte("more"))
	if err != nil || n != 4 {
		t.Fatalf("a write past the cap must still say it took everything: %d, %v", n, err)
	}
	if said.String() != "0123456789" {
		t.Fatalf("it kept %q, which is not the first ten bytes", said.String())
	}
}

// The password is offered once. A box that refuses it twice counts two wrong passwords against the account,
// and the library would otherwise offer it again on a second round.
func TestThePasswordIsOfferedOnce(t *testing.T) {
	entered := 0
	ask := offerOnce("a password", func() { entered++ })
	got, err := ask()
	if err != nil || got != "a password" {
		t.Fatalf("the first ask must give the password: %q, %v", got, err)
	}
	if entered != 1 {
		t.Fatalf("the sign-in phase must begin once: %d", entered)
	}
	if _, err := ask(); err == nil {
		t.Fatal("the second ask must be refused, and was not")
	}
	if entered != 1 {
		t.Fatalf("a refused ask must not begin the phase again: %d", entered)
	}
}

// A box that asks its own questions at sign-in: a code from a phone, or anything else only a person can
// answer. Before this, such a box could not be visited from Berth at all. The questions must reach whoever
// is asked, the answers must reach the box, and nothing else about the visit may change.
func TestABoxThatAsksItsOwnQuestions(t *testing.T) {
	w := setup(t, func(c *hostile.Config) {
		c.Sessions = true
		c.Asks = [][]string{{"Verification code:"}, {"Which colour?", "And again:"}}
		c.Shown = [][]bool{{false}, {true, false}}
		c.Answers = [][]string{{"123456"}, {"blue", "blue"}}
	})
	w.box.AnswerCommandsWith("visited\n")
	var asked [][]string
	var shown [][]bool
	said, e := FirstVisit(context.Background(), w.target, "the password", "echo visited", Options{
		OnAsk: func(questions []string, show []bool) ([]string, error) {
			asked = append(asked, append([]string(nil), questions...))
			shown = append(shown, append([]bool(nil), show...))
			if len(questions) == 1 {
				return []string{"123456"}, nil
			}
			return []string{"blue", "blue"}, nil
		},
	})
	if e != nil {
		t.Fatalf("the visit failed: %v", e)
	}
	if said == "" {
		t.Fatal("the box said nothing back")
	}
	if len(asked) != 2 || len(asked[0]) != 1 || asked[0][0] != "Verification code:" || len(asked[1]) != 2 {
		t.Fatalf("what was asked: %v", asked)
	}
	// Whether an answer is to be seen as it is typed is the box's to say, and it reaches the screen: a code
	// read off a phone is shown, a password is not.
	if len(shown) != 2 || shown[0][0] || !shown[1][0] || shown[1][1] {
		t.Fatalf("what was to be shown: %v", shown)
	}
}

// With nobody to ask, such a box is refused exactly as it was before, and the refusal says what it is: a
// visit that failed as though the password were wrong would send him looking for the wrong thing.
func TestABoxThatAsksWithNobodyToAnswer(t *testing.T) {
	w := setup(t, func(c *hostile.Config) {
		c.Sessions = true
		c.Asks = [][]string{{"Verification code:", "And your mother's name:"}}
		c.Answers = [][]string{{"123456", "no"}}
	})
	_, e := FirstVisit(context.Background(), w.target, "the password", "echo visited", Options{})
	if e == nil || !errors.Is(e.Err, ErrAskedSomethingElse) {
		t.Fatalf("it did not say the box asked something else: %v", e)
	}
}

// A box that keeps asking cannot keep a person answering for ever, and one that asks more at once than any
// real box does is refused rather than drawn.
func TestABoxCannotAskWithoutEnd(t *testing.T) {
	rounds := make([][]string, AskRoundMax+2)
	answers := make([][]string, len(rounds))
	for i := range rounds {
		rounds[i] = []string{"Again:"}
		answers[i] = []string{"yes"}
	}
	w := setup(t, func(c *hostile.Config) {
		c.Sessions = true
		c.Asks = rounds
		c.Answers = answers
	})
	tries := 0
	_, e := FirstVisit(context.Background(), w.target, "the password", "echo visited", Options{
		OnAsk: func(questions []string, _ []bool) ([]string, error) {
			tries++
			return []string{"yes"}, nil
		},
	})
	if e == nil || !errors.Is(e.Err, ErrAskedSomethingElse) {
		t.Fatalf("a box that asks without end was not refused: %v", e)
	}
	if tries > AskRoundMax {
		t.Fatalf("it asked %d times; at most %d", tries, AskRoundMax)
	}

	many := make([]string, AskMax+1)
	for i := range many {
		many[i] = "Answer:"
	}
	w2 := setup(t, func(c *hostile.Config) {
		c.Sessions = true
		c.Asks = [][]string{many}
		c.Answers = [][]string{many}
	})
	reached := false
	_, e2 := FirstVisit(context.Background(), w2.target, "the password", "echo visited", Options{
		OnAsk: func([]string, []bool) ([]string, error) {
			reached = true
			return nil, nil
		},
	})
	if e2 == nil || !errors.Is(e2.Err, ErrAskedSomethingElse) {
		t.Fatalf("too many questions at once was not refused: %v", e2)
	}
	if reached {
		t.Fatal("a box asking more at once than any real box does reached the screen")
	}
}
