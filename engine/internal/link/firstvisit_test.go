package link

import (
	"context"
	"strings"
	"testing"
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
