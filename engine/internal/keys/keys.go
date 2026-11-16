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
	"crypto/rsa"
	"crypto/x509"
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
	ErrTooBig      = errors.New("keys: more of the app's own part than one answer can carry")
	errUnsupported = errors.New("keys: a key of a kind this app does not make")

	// Bringing in a key file (plan O1). Each is a different thing to tell the person.
	ErrBadKeyFile      = errors.New("keys: that file is not a private key")
	ErrNeedsPassphrase = errors.New("keys: that key file has a passphrase")
	ErrWrongPassphrase = errors.New("keys: that passphrase does not open the key file")
	ErrKeyKind         = errors.New("keys: a kind of key this app will not sign with")
	ErrKeyTooSmall     = errors.New("keys: an RSA key smaller than this app will use")
)

const (
	formatVersion = 1
	maxKeys       = 4096
	maxNameLen    = 64
	maxUserLen    = 64
	maxKeyFile    = 64 * 1024 // a private key file; the largest real one is a few kilobytes
	minRSABits    = 2048      // OpenSSH's own floor, and below it the key is not worth bringing in
)

// key is one box's key. A key this app made is an ed25519 one and Seed is the whole of it. A key brought in
// from a file the person already had (plan O1) can be of any kind OpenSSH uses, so it is kept as PKCS#8, the
// one form that holds every kind, and Seed is empty. Exactly one of the two is ever set.
type key struct {
	Type    string    `json:"type"`
	Seed    []byte    `json:"seed,omitempty"`
	Priv    []byte    `json:"priv,omitempty"` // a key brought in, as PKCS#8
	Origin  string    `json:"origin,omitempty"`
	Box     string    `json:"box"`  // the one box this key signs in to
	User    string    `json:"user"` // as this one user
	Created time.Time `json:"created"`
}

// How a key got here. A key with no origin written down is one this app made, from before keys could be brought
// in; it is not guessed at anywhere, only shown.
const (
	OriginMade     = "made"
	OriginImported = "imported"
)

// The one place a key becomes something that can sign. Nothing else in this package touches the private bytes,
// and nothing anywhere returns them.
//
// The caller must call the returned wipe when it has finished signing, and not before: a signer holds the very
// bytes it was built from, so wiping them first leaves a signer that produces signatures nothing can verify.
func (k *key) signer() (s ssh.Signer, wipe func(), err error) {
	switch {
	case len(k.Seed) == ed25519.SeedSize && len(k.Priv) == 0 && k.Type == ssh.KeyAlgoED25519:
		priv := ed25519.NewKeyFromSeed(k.Seed)
		s, err = ssh.NewSignerFromKey(priv)
		if err != nil {
			clear(priv)
			return nil, func() {}, errUnsupported
		}
		return s, func() { clear(priv) }, nil
	case len(k.Priv) > 0 && len(k.Seed) == 0:
		parsed, err := x509.ParsePKCS8PrivateKey(k.Priv)
		if err != nil {
			return nil, func() {}, errUnsupported
		}
		s, err = ssh.NewSignerFromKey(parsed)
		if err != nil {
			return nil, func() {}, errUnsupported
		}
		// What the key says it is and what it turns out to be must agree, or a list changed from outside could
		// make a key of one kind sign as another.
		if s.PublicKey().Type() != k.Type {
			return nil, func() {}, errUnsupported
		}
		return s, func() {}, nil
	default:
		return nil, func() {}, errUnsupported
	}
}

// What a key of this kind may be asked to sign with. ssh-rsa is left out on purpose: it is SHA-1, and no box
// this app talks to needs it (OpenSSH stopped offering it by default in 8.8, and the oldest supported here is
// 8.9). A kind not named here cannot be brought in at all.
var signsWith = map[string][]string{
	ssh.KeyAlgoED25519:  {ssh.KeyAlgoED25519},
	ssh.KeyAlgoRSA:      {ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256},
	ssh.KeyAlgoECDSA256: {ssh.KeyAlgoECDSA256},
	ssh.KeyAlgoECDSA384: {ssh.KeyAlgoECDSA384},
	ssh.KeyAlgoECDSA521: {ssh.KeyAlgoECDSA521},
}

func maySign(keyType, algorithm string) bool {
	for _, a := range signsWith[keyType] {
		if a == algorithm {
			return true
		}
	}
	return false
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

// MaxPublic is the most the app's own part of the list may be.
//
// The whole of it travels back in one answer when the list is opened, and one message between these programs
// is at most 1 MiB, so a list bigger than this could be saved and never opened again. It is refused here, at
// the moment it is set, where the app can still be told why, rather than at the next start.
const MaxPublic = 512 * 1024

// SetPublic replaces the rest of the app's part. It must be one JSON object, and it must fit in an answer.
func (l *List) SetPublic(p json.RawMessage) error {
	if len(p) > MaxPublic {
		return ErrTooBig
	}
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
	Type      string // the kind of key it is, as SSH names it
	Origin    string // made here, or brought in from a file (plan O1)
	PublicKey string // one authorized-keys line
	Created   time.Time
}

func (l *List) info(name string, k *key) Info {
	line := ""
	origin := k.Origin
	if origin == "" {
		origin = OriginMade // written down only since keys could be brought in; an older key is one this app made
	}
	if s, wipe, err := k.signer(); err == nil {
		line = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.PublicKey())))
		wipe()
	}
	return Info{Name: name, Box: k.Box, User: k.User, Type: k.Type, Origin: origin, PublicKey: line, Created: k.Created}
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
	k := &key{Type: ssh.KeyAlgoED25519, Seed: append([]byte(nil), priv.Seed()...), Origin: OriginMade, Box: box, User: user, Created: now.UTC().Truncate(time.Second)}
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
	// The algorithm must be one this kind of key is allowed to sign with. A key brought in may be of another
	// kind than the ones this app makes, and the pair is checked here rather than anywhere the caller chooses.
	if !maySign(k.Type, algorithm) {
		return nil, errUnsupported
	}
	signer, wipe, err := k.signer()
	if err != nil {
		return nil, err
	}
	defer wipe()
	pub := signer.PublicKey()

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

	// An RSA key signs with the algorithm the box asked for, not with the key's own name, which is SHA-1.
	var sig *ssh.Signature
	if as, ok := signer.(ssh.AlgorithmSigner); ok && algorithm != signer.PublicKey().Type() {
		sig, err = as.SignWithAlgorithm(rand.Reader, data, algorithm)
	} else {
		sig, err = signer.Sign(rand.Reader, data)
	}
	if err != nil {
		return nil, err
	}
	if sig.Format != algorithm {
		return nil, errUnsupported
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

// TakeKey brings in a key the person already has, from a file (plan O1). It exists so that adding a box needs
// nothing but Berth: his boxes already hold his public key, so the private half is the way in, and without this
// the first key has to reach a box through some other program (Kami, 2026-11-17: "Berth shouldn't rely on any
// other app to add a box").
//
// What arrives is the file's bytes and, if it has one, its passphrase. Neither is kept: the file is parsed, the
// private key is held as PKCS#8 inside the list like any other, and the bytes handed in are wiped by the caller.
// A kind of key this app will not sign with is refused here rather than at the first sign-in.
func (l *List) TakeKey(name, box, user string, file, passphrase []byte, now time.Time) (Info, error) {
	if !usableName(name, maxNameLen) || !usableName(box, maxNameLen) || !usableUser(user) {
		return Info{}, ErrBadName
	}
	if _, taken := l.keys[name]; taken {
		return Info{}, ErrKeyInUse
	}
	if len(l.keys) >= maxKeys {
		return Info{}, ErrTooMuch
	}
	if len(file) == 0 || len(file) > maxKeyFile {
		return Info{}, ErrBadKeyFile
	}

	var parsed any
	var err error
	if len(passphrase) == 0 {
		parsed, err = ssh.ParseRawPrivateKey(file)
	} else {
		parsed, err = ssh.ParseRawPrivateKeyWithPassphrase(file, passphrase)
	}
	if err != nil {
		// Whether a key file needs a passphrase is told apart from everything else, because it is the one
		// refusal the person can do something about.
		var needs *ssh.PassphraseMissingError
		if errors.As(err, &needs) {
			return Info{}, ErrNeedsPassphrase
		}
		if len(passphrase) > 0 {
			return Info{}, ErrWrongPassphrase
		}
		return Info{}, ErrBadKeyFile
	}

	// A key file is parsed into a pointer for some kinds and a value for others; PKCS#8 takes ed25519 by
	// value only, so the one odd case is settled here rather than left to fail further down as "a kind this
	// app will not sign with", which it is not.
	if p, ok := parsed.(*ed25519.PrivateKey); ok {
		parsed = *p
	}
	signer, err := ssh.NewSignerFromKey(parsed)
	if err != nil {
		return Info{}, ErrKeyKind
	}
	kind := signer.PublicKey().Type()
	if len(signsWith[kind]) == 0 {
		return Info{}, ErrKeyKind
	}
	if rsaBits(parsed) > 0 && rsaBits(parsed) < minRSABits {
		return Info{}, ErrKeyTooSmall
	}
	der, err := x509.MarshalPKCS8PrivateKey(parsed)
	if err != nil {
		return Info{}, ErrKeyKind
	}

	k := &key{Type: kind, Priv: der, Origin: OriginImported, Box: box, User: user, Created: now.UTC().Truncate(time.Second)}
	// It must be able to sign before it is kept, so a key that cannot be used is refused now and not at the
	// first sign-in, when the person is somewhere else entirely.
	if _, wipe, err := k.signer(); err != nil {
		clear(der)
		return Info{}, ErrKeyKind
	} else {
		wipe()
	}
	l.keys[name] = k
	return l.info(name, k), nil
}

// TryKeyFile reads a key file and says what is in it, without keeping anything. It exists so the person can see
// which key a file holds, and be asked for its passphrase, before the box is made: a key file that turns out to
// be the wrong one, or to need a passphrase, should be found out on the screen where it was chosen.
//
// It returns the public half as one authorized-keys line and the kind of key. The private half is parsed,
// checked and dropped; nothing is written to the list.
func TryKeyFile(file, passphrase []byte) (line, kind string, err error) {
	l := &List{keys: map[string]*key{}, public: json.RawMessage(`{}`)}
	info, err := l.TakeKey("try", "try", "try", file, passphrase, time.Time{})
	// Whatever happened, the list made here is thrown away with this function; it was never on disk and nothing
	// outside this call can reach it.
	delete(l.keys, "try")
	if err != nil {
		return "", "", err
	}
	return info.PublicKey, info.Type, nil
}

// How big an RSA key is, or 0 if it is not one.
func rsaBits(parsed any) int {
	if r, ok := parsed.(*rsa.PrivateKey); ok {
		return r.N.BitLen()
	}
	return 0
}
