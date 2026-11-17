package main

// The first visit's own process (decision O2, plan B2.5 entry 5): the same program, aimed with the role
// "firstvisit", one box, one user, one pinned identity, one password and one command. It signs in once, runs
// that command, says what the box printed, and ends.
//
// It is its own run of the program for the same reason the first-connection check is: a tab's engine must
// never be able to do this. This one is given no key name and there is no frame by which it could ask the key
// process for a signature, so the only thing it can do with the password it is handed is the one thing it was
// started for.
//
// The password arrives on standard input, inside the aim, and lives only as long as this process does, which
// is a few seconds. It is never written down by this program.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/frame"
	"sshapp/engine/internal/link"
)

func runFirstVisit(o *out, a aim) int {
	if a.Box.Addr == "" || a.Box.User == "" || a.Box.HostKey == "" || a.Password == "" || a.Command == "" {
		o.fatal(exitNoAim, "Aim does not hold a whole first visit")
	}
	hostKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(a.Box.HostKey))
	if err != nil {
		o.fatal(exitNoAim, "Aim's pinned identity cannot be read")
	}
	hello, _ := json.Marshal(map[string]any{"v": 1, "role": "firstvisit"})
	o.send(frame.TypeHello, hello)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for {
			f, e := frame.Read(os.Stdin)
			if e != nil {
				if errors.Is(e, io.EOF) {
					cancel() // main is gone, or gave up on this visit
					return
				}
				o.fatal(exitBadFrame, "bad frame: "+e.Error())
			}
			if f.Type != frame.TypePing {
				o.fatal(exitBadFrame, "not a frame for a first visit")
			}
			o.send(frame.TypePong, f.Body)
		}
	}()

	state := func(v map[string]any) {
		body, _ := json.Marshal(v)
		o.send(frame.TypeState, body)
	}
	said, e := link.FirstVisit(ctx, link.Target{Addr: a.Box.Addr, User: a.Box.User, HostKey: hostKey}, a.Password, a.Command, link.Options{
		OnPhase: func(p link.Phase) { state(map[string]any{"state": string(p)}) },
	})
	if e != nil {
		if ctx.Err() != nil {
			return exitOK
		}
		ended := endedState(e)
		if errors.Is(e.Err, link.ErrAskedSomethingElse) {
			ended["cause"] = "asked-something-else"
		}
		state(ended)
		return exitOK
	}
	// What the box printed goes back as text and nothing else. It is a box's own words: main shows it where
	// box text is shown, escaped and capped, and never acts on it.
	state(map[string]any{"state": "visited", "said": said})
	return exitOK
}
