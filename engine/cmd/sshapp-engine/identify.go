package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/frame"
	"sshapp/engine/internal/link"
)

// The first-connection check's own process (plan B2.3): the same program, aimed with the role "identify" and
// one address. It asks that box who it is and says the answer to main, as the key's kind, its fingerprint and
// the key itself; or it says exactly why there is no answer. Then it ends.
//
// It is given no user, no key name and no pinned identity, and there is no frame by which it could ask for a
// signature: a box that answers in place of the real one gains nothing from it. What it reports is not trusted
// by being reported. Main keeps it back until what the box itself printed, in a trusted place, has been pasted
// and compared.
func runIdentify(o *out, addr string) int {
	if addr == "" {
		o.fatal(exitNoAim, "Aim names no box to ask")
	}
	hello, _ := json.Marshal(map[string]any{"v": 1, "role": "identify"})
	o.send(frame.TypeHello, hello)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for {
			f, err := frame.Read(os.Stdin)
			if err != nil {
				if errors.Is(err, io.EOF) {
					cancel() // main is gone, or gave up on this check
					return
				}
				o.fatal(exitBadFrame, "bad frame: "+err.Error())
			}
			if f.Type != frame.TypePing {
				o.fatal(exitBadFrame, "not a frame for a first-connection check")
			}
			o.send(frame.TypePong, f.Body)
		}
	}()

	state := func(v map[string]any) {
		body, _ := json.Marshal(v)
		o.send(frame.TypeState, body)
	}
	key, e := link.Identify(ctx, addr, link.Options{OnPhase: func(p link.Phase) { state(map[string]any{"state": string(p)}) }})
	if e != nil {
		if ctx.Err() != nil {
			return exitOK // nobody is listening any more
		}
		state(endedState(e))
		return exitOK
	}
	state(map[string]any{
		"state":       "identified",
		"type":        key.Type(),
		"fingerprint": ssh.FingerprintSHA256(key),
		"key":         strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))),
	})
	return exitOK
}
