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
//	manyfiles <folder> <count>      make a folder with that many things in it, under the box's own files
//	filepace <ms>                   wait this long before answering each page of a listing
//	bigfile <path> <bytes>          write a file of that many bytes of real text, under the box's own files
//	pages                           {"pages":N}: how many pages of a listing it has been asked for in all
//	keyfile <path> [passphrase]     write a private key file where a person's own would be, in the format
//	                                OpenSSH writes, and say its public half and fingerprint
//	rekey                           become another box at the same address: a new identity, nothing else changed
//	read <path>                     {"text":"..."}: what one of the box's own files holds
//	forget <path>                   take one of the box's own files away
//	hashof <path>                   {"sha256":"..."}: the box's own hash of one of its files
//	failreads <bytes>               answer no read from this offset on, as a link going down looks from here
//	nofiles <n>                     say no to the next n asks for the file subsystem, as a busy box does
//	pretendsize <name> <bytes>      the box says that file is that big, whatever it really is
//	oddnames <folder>               make files whose names a PC cannot hold as they are
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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sshapp/engine/internal/lab/hostile"
	"strconv"
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
	// A real folder for its file subsystem, so the app's own file browser can be driven against it. It is
	// made here with a few things of each kind in it, and goes when the lab box does.
	files, err := os.MkdirTemp("", "labbox-files-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(files)
	// The folders the self-test's own places point at are here too, so a tab opened on a place has something
	// real to list. Paths are taken as being under this folder, so "/var/log" is this folder's own var/log.
	for _, d := range []string{"logs", "releases", "empty", "var/log", "var/log/ledger", "srv/ledger"} {
		_ = os.MkdirAll(filepath.Join(files, d), 0o755)
	}
	_ = os.WriteFile(filepath.Join(files, "var", "log", "syslog"), []byte("a line of the box's own log\n"), 0o644)
	_ = os.WriteFile(filepath.Join(files, "var", "log", "ledger", "today.log"), []byte("ledger\n"), 0o644)
	_ = os.WriteFile(filepath.Join(files, "notes.txt"), []byte("a file on the lab box\n"), 0o644)
	_ = os.WriteFile(filepath.Join(files, "kit.tar.gz"), make([]byte, 23_400), 0o644)
	_ = os.WriteFile(filepath.Join(files, "logs", "today.log"), []byte("line one\nline two\n"), 0o644)
	_ = os.Symlink("notes.txt", filepath.Join(files, "latest"))
	// A link inside a listed folder, so the window can be shown something that is neither a file nor a folder
	// in the same place it shows the rest.
	_ = os.Symlink("syslog", filepath.Join(files, "var", "log", "current"))

	box, err := hostile.Start(hostile.Config{HostSigner: host, Sessions: true, FilesUnder: files, Banner: "Welcome to the lab box\n\x1b[c\x1b]52;c;aGlkZGVu\x07\x1b[31msecond line\n*** System restart required ***\n"})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	addr := box.Addr()
	say(map[string]any{"addr": addr, "printed": printed(host.PublicKey()), "files": files})

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
		case "bigfile":
			// A file larger than the viewer will read, made of real text, so the cap can be driven.
			where, n, _ := strings.Cut(rest, " ")
			want := 0
			for _, c := range n {
				if c < '0' || c > '9' {
					want = -1
					break
				}
				want = want*10 + int(c-'0')
			}
			if want < 1 || want > 64<<20 {
				say(map[string]any{"error": "a size between 1 and 67108864"})
				continue
			}
			line := []byte("a line of a file that is larger than the viewer will read\n")
			var body []byte
			for len(body) < want {
				body = append(body, line...)
			}
			body = body[:want]
			full := filepath.Join(files, filepath.FromSlash(strings.TrimPrefix(where, "/")))
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				say(map[string]any{"error": err.Error()})
				continue
			}
			if err := os.WriteFile(full, body, 0o644); err != nil {
				say(map[string]any{"error": err.Error()})
				continue
			}
			say(map[string]any{"wrote": where, "bytes": len(body)})
		case "aged":
			// Puts an old time of change on a file that is already there, so the window's own date column has
			// something that is not today in it. Every file this lab makes is made now, so a probe that reads
			// the column sees today's shape alone and cannot tell a column that drops the date from one that
			// keeps it. The argument is the path and how many days back, as "var/log/syslog 400".
			parts := strings.Fields(strings.TrimSpace(rest))
			if len(parts) != 2 {
				say(map[string]any{"error": "a path and how many days back"})
				continue
			}
			days, err := strconv.Atoi(parts[1])
			if err != nil || days < 1 || days > 20000 {
				say(map[string]any{"error": "a number of days between 1 and 20000"})
				continue
			}
			full := filepath.Join(files, filepath.FromSlash(strings.TrimPrefix(parts[0], "/")))
			when := time.Now().AddDate(0, 0, -days)
			if err := os.Chtimes(full, when, when); err != nil {
				say(map[string]any{"error": err.Error()})
				continue
			}
			say(map[string]any{"aged": parts[0], "to": when.UTC().Format(time.RFC3339)})
		case "pages":
			say(map[string]any{"pages": hostile.Pages()})
		case "filepace":
			// How long the box waits before answering each page of a listing, so a listing takes a known time.
			ms := 0
			for _, c := range strings.TrimSpace(rest) {
				if c < '0' || c > '9' {
					ms = -1
					break
				}
				ms = ms*10 + int(c-'0')
			}
			if ms < 0 || ms > 5000 {
				say(map[string]any{"error": "a wait between 0 and 5000 ms"})
				continue
			}
			hostile.Pace(int64(ms))
			say(map[string]any{"pace": ms})
		case "manyfiles":
			// A folder with a great many things in it, so a listing can be left part-read and the window's
			// handling of that proven. The count is given; the folder is made under the box's own files.
			where, n, _ := strings.Cut(rest, " ")
			count := 0
			for _, c := range n {
				if c < '0' || c > '9' {
					count = 0
					break
				}
				count = count*10 + int(c-'0')
			}
			if count < 1 || count > 100_000 {
				say(map[string]any{"error": "a count between 1 and 100000"})
				continue
			}
			dir := filepath.Join(files, filepath.FromSlash(strings.TrimPrefix(where, "/")))
			if err := os.MkdirAll(dir, 0o755); err != nil {
				say(map[string]any{"error": err.Error()})
				continue
			}
			made := 0
			for i := 0; i < count; i++ {
				name := fmt.Sprintf("thing-%05d.dat", i)
				if os.WriteFile(filepath.Join(dir, name), nil, 0o644) == nil {
					made++
				}
			}
			say(map[string]any{"made": made, "in": where})
		case "seen":
			tries, users := box.SignInTries()
			say(map[string]any{"tries": tries, "users": users, "sessions": box.Sessions()})
		case "pretendsize":
			// <name> <bytes>: the box says that file is that big, whatever it really is.
			bits := strings.Fields(rest)
			if len(bits) != 2 {
				say(map[string]any{"error": "a name and a count"})
				continue
			}
			n, err := strconv.ParseUint(bits[1], 10, 64)
			if err != nil {
				say(map[string]any{"error": "a count"})
				continue
			}
			hostile.PretendSize(bits[0], n)
			say(map[string]any{"pretending": bits[0], "size": n})
		case "oddnames":
			// Files whose names a PC cannot hold as they are, under the box's own files.
			made := 0
			for _, name := range []string{"a:b.txt", "con.txt", "trailing. ", "shortcut.lnk", "two|pipes.log"} {
				if os.WriteFile(filepath.Join(files, filepath.FromSlash(rest), name), []byte("a file whose name a PC cannot hold\n"), 0o644) == nil {
					made++
				}
			}
			say(map[string]any{"made": made})
		case "read":
			// What one of the box's own files holds, so the self-test can see what a send really left there.
			b, err := os.ReadFile(filepath.Join(files, filepath.FromSlash(rest)))
			if err != nil {
				say(map[string]any{"error": "no such file"})
				continue
			}
			say(map[string]any{"text": string(b)})
		case "look":
			// What the box itself holds at one path: whether it is there at all, and what kind of thing it is.
			// A folder cannot be read, so this is how a test sees that one a window says it made is really on
			// the box, and not only drawn.
			st, err := os.Lstat(filepath.Join(files, filepath.FromSlash(rest)))
			if err != nil {
				say(map[string]any{"error": "no such file"})
				continue
			}
			kind := "file"
			if st.IsDir() {
				kind = "folder"
			} else if st.Mode()&os.ModeSymlink != 0 {
				kind = "link"
			}
			say(map[string]any{"kind": kind, "size": st.Size(), "mode": fmt.Sprintf("%o", st.Mode().Perm())})
		case "forget":
			// Take one of the box's own files away again, so a test can run twice.
			say(map[string]any{"gone": os.Remove(filepath.Join(files, filepath.FromSlash(rest))) == nil})
		case "hashof":
			// The box's own sha256 of one of its files, so a test can compare what arrived with what it has.
			b, err := os.ReadFile(filepath.Join(files, filepath.FromSlash(rest)))
			if err != nil {
				say(map[string]any{"error": "no such file"})
				continue
			}
			sum := sha256.Sum256(b)
			say(map[string]any{"sha256": hex.EncodeToString(sum[:])})
		case "failreads":
			// <bytes>: the box answers no read from this offset on, as a link going down looks from here.
			n, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
			if err != nil || n < 0 {
				say(map[string]any{"error": "a count"})
				continue
			}
			hostile.FailReadsAt(n)
			say(map[string]any{"failingFrom": n})
		case "nofiles":
			n, err := strconv.Atoi(rest)
			if err != nil || n < 0 {
				say(map[string]any{"error": "a count"})
				continue
			}
			box.RefuseFiles(n)
			say(map[string]any{"refusing": n})
		case "prompting":
			// <prompt>: the shells print this prompt, echo what they are given, and print it again. Empty
			// turns it off. It is how a test sees the app read a real shell's shape over a real link.
			box.Prompting(strings.TrimSpace(rest))
			say(map[string]any{"prompting": strings.TrimSpace(rest)})
		case "banner":
			// <text>, or nothing at all for a box that says nothing at sign-in, as nearly every real box does.
			// \n in the text is a real newline, so a banner of nothing but blank lines can be asked for: a box
			// that prints two newlines and no words has said nothing, and the window must agree.
			said := strings.ReplaceAll(strings.TrimSpace(rest), "\\n", "\n")
			box.SetBanner(said)
			say(map[string]any{"banner": said})
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
