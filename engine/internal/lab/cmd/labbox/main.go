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
//	keyfile <path> [passphrase]     write a private key file where a person's own would be, in the format
//	                                OpenSSH writes, and say its public half and fingerprint
//	rekey                           become another box at the same address: a new identity, nothing else changed
//	quiet on|off                    the shells stop (or start again) sending back what they are given
//	print <hex>                     print these bytes in every open session, as a program on the box would
//	received                        {"hex":"..."}: every byte the shells were given since this was last asked
//	flood <ms> [bytes a second]     every open session prints for this long: so much a second each, or (none
//	                                given) as fast as its client takes it
//	flooded                         {"bytes":N}: how much the sessions took from flood, in all
//	hold <ms>                       every connection goes silent both ways for this long, nothing lost
//	reset                           every connection ends with a real reset, as a dropped network does
//	stall on|off                    sign-ins are never answered (or are again), as a box stopped halfway
//
// It ends when its input closes.
package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sshapp/engine/internal/lab/hostile"
	"strings"
	"time"

	"encoding/pem"
	"golang.org/x/crypto/ssh"
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
	box, err := hostile.Start(hostile.Config{HostSigner: host, Sessions: true, Banner: "Welcome to the lab box\n\x1b[c\x1b]52;c;aGlkZGVu\x07\x1b[31msecond line\n*** System restart required ***\n"})
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
		case "keyfile":
			// Writes a private key file of the kind a person already has, so the lab can drive bringing one in
			// (plan O1) against a real file in the format OpenSSH writes, with or without a passphrase.
			where, pass, _ := strings.Cut(rest, " ")
			_, priv, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				say(map[string]any{"error": err.Error()})
				continue
			}
			var block *pem.Block
			if pass == "" {
				block, err = ssh.MarshalPrivateKey(priv, "")
			} else {
				block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, "", []byte(pass))
			}
			if err != nil {
				say(map[string]any{"error": err.Error()})
				continue
			}
			if err := os.WriteFile(where, pem.EncodeToMemory(block), 0o600); err != nil {
				say(map[string]any{"error": err.Error()})
				continue
			}
			signer, err := ssh.NewSignerFromKey(priv)
			if err != nil {
				say(map[string]any{"error": err.Error()})
				continue
			}
			say(map[string]any{"wrote": where, "publicKey": strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))), "fingerprint": ssh.FingerprintSHA256(signer.PublicKey())})
		case "seen":
			tries, users := box.SignInTries()
			say(map[string]any{"tries": tries, "users": users, "sessions": box.Sessions()})
		case "quiet":
			box.Quiet(rest == "on")
			say(map[string]any{"quiet": rest == "on"})
		case "print":
			raw, err := hex.DecodeString(rest)
			if err != nil {
				say(map[string]any{"error": "not hex"})
				continue
			}
			box.Print(raw)
			say(map[string]any{"printed": len(raw)})
		case "flood":
			var ms, perSecond int
			if n, _ := fmt.Sscanf(rest, "%d %d", &ms, &perSecond); n < 1 || ms < 1 || ms > 60000 || perSecond < 0 {
				say(map[string]any{"error": "flood <milliseconds> [bytes a second for each session]"})
				continue
			}
			say(map[string]any{"flooding": box.Flood(time.Duration(ms)*time.Millisecond, perSecond)})
		case "flooded":
			say(map[string]any{"bytes": box.Flooded()})
		case "hold":
			var ms int
			if n, _ := fmt.Sscanf(rest, "%d", &ms); n < 1 || ms < 1 || ms > 600000 {
				say(map[string]any{"error": "hold <milliseconds>"})
				continue
			}
			say(map[string]any{"holding": box.Hold(time.Duration(ms) * time.Millisecond)})
		case "reset":
			say(map[string]any{"reset": box.Reset()})
		case "stall":
			box.Stall(rest == "on")
			say(map[string]any{"stall": rest == "on"})
		case "received":
			say(map[string]any{"hex": hex.EncodeToString(box.Received())})
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
