// Command labbox is a lab tool, never part of the app: a stand-in for a box, for the app's own self-test.
// It is the lab's hostile server (an SSH server that takes terminal sessions and sends back what it is given),
// run as a program the self-test can start, and told what to do by lines on its standard input. The app talks
// to it exactly as it talks to a real box: through an engine, over SSH.
//
// It says one JSON line for each thing it is told. At start:
//
//	{"addr":"127.0.0.1:PORT","printed":"256 SHA256:... lab-box (ED25519)\n"}
//
// where "printed" is what a real box's ssh-keygen prints for its identity, the text a person pastes into the
// first-connection check. Then, per line of input:
//
//	accept <authorized-keys line>   let this key in, as when Berth's key is added on a box
//	seen                            {"tries":N,"users":[...],"sessions":[...]}: every sign-in try and session so far
//	rekey                           become another box at the same address: a new identity, nothing else changed
//
// It ends when its input closes.
package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/lab/hostile"
)

func say(v any) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

func identity() ssh.Signer {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		panic(err)
	}
	return s
}

func printed(k ssh.PublicKey) string {
	return "256 " + ssh.FingerprintSHA256(k) + " lab-box (ED25519)\n"
}

func main() {
	host := identity()
	var let ssh.PublicKey
	box, err := hostile.Start(hostile.Config{HostSigner: host, Sessions: true, Banner: "Welcome to the lab box\n"})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	addr := box.Addr()
	say(map[string]any{"addr": addr, "printed": printed(host.PublicKey())})

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 64*1024)
	for in.Scan() {
		word, rest, _ := strings.Cut(strings.TrimSpace(in.Text()), " ")
		switch word {
		case "accept":
			key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(rest))
			if err != nil {
				say(map[string]any{"error": "not a key line"})
				continue
			}
			let = key
			box.Accept(key)
			say(map[string]any{"accepting": ssh.FingerprintSHA256(key)})
		case "seen":
			tries, users := box.SignInTries()
			say(map[string]any{"tries": tries, "users": users, "sessions": box.Sessions()})
		case "rekey":
			box.Close()
			host = identity()
			box, err = hostile.Start(hostile.Config{HostSigner: host, Accept: let, Sessions: true, Listen: addr})
			if err != nil {
				say(map[string]any{"error": err.Error()})
				os.Exit(1)
			}
			say(map[string]any{"addr": addr, "printed": printed(host.PublicKey())})
		default:
			say(map[string]any{"error": "unknown word"})
		}
	}
	box.Close()
}
