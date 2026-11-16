// Package keys is what the key process knows and does (plan B1, B2.4): the locked list in memory, the keys
// inside it, and the one thing a key is ever used for, signing a box's sign-in.
//
// A key is made here, lives only inside the list, and never leaves: nothing in this package returns a private
// key, and the only output made with one is a signature over a request that was checked field by field first.
// What the rest of the app keeps in the list (boxes, places, settings) is carried as it is and not read here.
package keys

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Every refusal. Each is a different thing to say.
var (
	ErrNoSuchKey   = errors.New("keys: no such key")
	ErrNotThisBox  = errors.New("keys: this key belongs to another box")
	ErrBadRequest  = errors.New("keys: not a sign-in request this key may sign")
	ErrBadList     = errors.New("keys: the list's contents cannot be read")
	ErrKeyInUse    = errors.New("keys: a key with this name exists")
	ErrBadName     = errors.New("keys: not a usable name")
	ErrTooMuch     = errors.New("keys: more than a list may hold")
	errUnsupported = errors.New("keys: a key of a kind this app does not make")
)

const (
	formatVersion = 1
	maxKeys       = 4096
	maxNameLen    = 64
	maxUserLen    = 64
)

// key is one box's key. Seed is the whole private key (ed25519).
type key struct {
	Type    string    `json:"type"`
	Seed    []byte    `json:"seed"`
	Box     string    `json:"box"`  // the one box this key signs in to
	User    string    `json:"user"` // as this one user
	Created time.Time `json:"created"`
}

// List is the locked list, open in memory.
type List struct {
	keys      map[string]*key
	public    json.RawMessage // boxes, places, settings: the rest of the app's part, carried as it is
	backupDir string
}

type onDisk struct {
	V         int             `json:"v"`
	Public    json.RawMessage `json:"public"`
	Keys      map[string]*key `json:"keys"`
	BackupDir string          `json:"backupDir"`
}

// New is an empty list, for the first start.
func New() *List {
	return &List{keys: map[string]*key{}, public: json.RawMessage(`{}`)}
}

// Parse reads a list from the bytes the vault opened.
func Parse(contents []byte) (*List, error) {
	var d onDisk
	dec := json.NewDecoder(bytes.NewReader(contents))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil || d.V != formatVersion || len(d.Keys) > maxKeys {
		return nil, ErrBadList
	}
	l := &List{keys: map[string]*key{}, public: d.Public, backupDir: d.BackupDir}
	if len(l.public) == 0 {
		l.public = json.RawMessage(`{}`)
	}
	for name, k := range d.Keys {
		if k == nil || !usableName(name, maxNameLen) || k.Type != ssh.KeyAlgoED25519 || len(k.Seed) != ed25519.SeedSize || !usableName(k.Box, maxNameLen) || !usableUser(k.User) {
			return nil, ErrBadList
		}
		l.keys[name] = k
	}
	return l, nil
}

// Contents are the bytes to seal. The caller wipes them after sealing.
func (l *List) Contents() ([]byte, error) {
	return json.Marshal(onDisk{V: formatVersion, Public: l.public, Keys: l.keys, BackupDir: l.backupDir})
}

// Public is the rest of the app's part of the list. It holds no key.
func (l *List) Public() json.RawMessage { return l.public }

// SetPublic replaces the rest of the app's part. It must be one JSON object.
func (l *List) SetPublic(p json.RawMessage) error {
	var probe map[string]json.RawMessage
	if json.Unmarshal(p, &probe) != nil {
		return ErrBadList
	}
	l.public = append(json.RawMessage(nil), p...)
	return nil
}

// BackupDir is the folder a copy is written to at every save; empty for none yet.
func (l *List) BackupDir() string     { return l.backupDir }
func (l *List) SetBackupDir(d string) { l.backupDir = d }

// Info is what may be known about a key outside this package.
type Info struct {
	Name      string
	Box       string
	User      string
	PublicKey string // one authorized-keys line
	Created   time.Time
}

func (l *List) info(name string, k *key) Info {
	pub, _ := ssh.NewPublicKey(ed25519.NewKeyFromSeed(k.Seed).Public())
	return Info{Name: name, Box: k.Box, User: k.User, PublicKey: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))), Created: k.Created}
}

// Keys lists what is known about every key, by name.
func (l *List) Keys() []Info {
	out := make([]Info, 0, len(l.keys))
	for name, k := range l.keys {
		out = append(out, l.info(name, k))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// NewKey makes a key for one box and one user on it, from the operating system's random source.
func (l *List) NewKey(name, box, user string, now time.Time) (Info, error) {
	if !usableName(name, maxNameLen) || !usableName(box, maxNameLen) || !usableUser(user) {
		return Info{}, ErrBadName
	}
	if _, taken := l.keys[name]; taken {
		return Info{}, ErrKeyInUse
	}
	if len(l.keys) >= maxKeys {
		return Info{}, ErrTooMuch
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Info{}, err
	}
	k := &key{Type: ssh.KeyAlgoED25519, Seed: append([]byte(nil), priv.Seed()...), Box: box, User: user, Created: now.UTC().Truncate(time.Second)}
	clear(priv)
	l.keys[name] = k
	return l.info(name, k), nil
}

// Rebind changes the user a key signs in as (the box's user was edited). The key itself is unchanged.
func (l *List) Rebind(name, box, user string) error {
	k, ok := l.keys[name]
	if !ok {
		return ErrNoSuchKey
	}
	if k.Box != box {
		return ErrNotThisBox
	}
	if !usableUser(user) {
		return ErrBadName
	}
	k.User = user
	return nil
}

// Delete removes a key for good, wiping it.
func (l *List) Delete(name string) error {
	k, ok := l.keys[name]
	if !ok {
		return ErrNoSuchKey
	}
	clear(k.Seed)
	delete(l.keys, name)
	return nil
}

// Wipe overwrites every key in memory. The list is unusable afterwards.
func (l *List) Wipe() {
	for name, k := range l.keys {
		clear(k.Seed)
		delete(l.keys, name)
	}
}

// Sign signs one sign-in request with one key, for the one box that key belongs to, after checking every
// field of what it is asked to sign (plan B1). data is exactly what the SSH protocol has a client sign
// (RFC 4252, section 7):
//
//	string   the session's value: here always 32 bytes
//	byte     50, "this is a sign-in request"
//	string   the user
//	string   "ssh-connection"
//	string   "publickey"
//	boolean  true
//	string   the algorithm
//	string   the public key
//
// Anything else is refused: another user, another key's public half, another algorithm, a session value of
// another length, a byte too many. So a key cannot be made to sign anything but its own box's sign-in, whoever
// asks. The signature is returned in the protocol's own form.
func (l *List) Sign(name, box, algorithm string, data []byte) ([]byte, error) {
	k, ok := l.keys[name]
	if !ok {
		return nil, ErrNoSuchKey
	}
	if k.Box != box {
		return nil, ErrNotThisBox
	}
	if k.Type != ssh.KeyAlgoED25519 || algorithm != ssh.KeyAlgoED25519 {
		return nil, errUnsupported
	}
	priv := ed25519.NewKeyFromSeed(k.Seed)
	defer clear(priv)
	pub, err := ssh.NewPublicKey(priv.Public())
	if err != nil {
		return nil, err
	}

	rest := data
	session, rest, ok1 := takeString(rest)
	kind, rest, ok2 := takeByte(rest)
	user, rest, ok3 := takeString(rest)
	service, rest, ok4 := takeString(rest)
	method, rest, ok5 := takeString(rest)
	hasSig, rest, ok6 := takeByte(rest)
	alg, rest, ok7 := takeString(rest)
	blob, rest, ok8 := takeString(rest)
	switch {
	case !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8), len(rest) != 0:
		return nil, fmt.Errorf("%w: not in the protocol's form", ErrBadRequest)
	case len(session) != 32:
		return nil, fmt.Errorf("%w: the session value is %d bytes, not 32", ErrBadRequest, len(session))
	case kind != 50 || hasSig != 1 || string(service) != "ssh-connection" || string(method) != "publickey":
		return nil, fmt.Errorf("%w: not a public-key sign-in", ErrBadRequest)
	case string(user) != k.User:
		return nil, fmt.Errorf("%w: for another user", ErrBadRequest)
	case string(alg) != algorithm:
		return nil, fmt.Errorf("%w: names another algorithm", ErrBadRequest)
	case !bytes.Equal(blob, pub.Marshal()):
		return nil, fmt.Errorf("%w: names another key", ErrBadRequest)
	}

	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, err
	}
	sig, err := signer.Sign(rand.Reader, data)
	if err != nil {
		return nil, err
	}
	return ssh.Marshal(sig), nil
}

func takeString(b []byte) (s, rest []byte, ok bool) {
	if len(b) < 4 {
		return nil, nil, false
	}
	n := binary.BigEndian.Uint32(b)
	if uint64(n) > uint64(len(b)-4) {
		return nil, nil, false
	}
	return b[4 : 4+n], b[4+n:], true
}

func takeByte(b []byte) (v byte, rest []byte, ok bool) {
	if len(b) < 1 {
		return 0, nil, false
	}
	return b[0], b[1:], true
}

// A name for a key or a box inside the list: short, and plain enough to be a file-free identifier.
func usableName(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// A user on a box: what a Unix account name can be, and nothing that could be read as anything else.
func usableUser(s string) bool {
	if s == "" || len(s) > maxUserLen {
		return false
	}
	for _, r := range s {
		if r <= 0x20 || r == 0x7f || r > 0x7e {
			return false
		}
	}
	return true
}
