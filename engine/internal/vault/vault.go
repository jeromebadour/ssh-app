// Package vault seals and opens the locked list: the one file that holds the boxes, their pinned identities and
// their keys (plan B2.4). It turns a password and some bytes into a sealed file and back, and does nothing else:
// no disk, no network, no knowledge of what the bytes mean.
//
// The cryptography is not ours. The key comes from the password by Argon2id and the contents are sealed with
// XChaCha20-Poly1305, both from golang.org/x/crypto. Ours is only the envelope around them, written out here so
// a reviewer can check every byte:
//
//	offset  size  what
//	     0     8  magic "BERTHVLT"
//	     8     1  format version (1)
//	     9     1  key derivation (1 = Argon2id, version 1.3)
//	    10     1  cipher (1 = XChaCha20-Poly1305)
//	    11     1  Argon2id threads
//	    12     4  Argon2id passes, big endian
//	    16     4  Argon2id memory in KiB, big endian
//	    20     8  when it was saved, seconds since 1970 UTC, big endian, signed
//	    28    16  salt
//	    44    24  nonce
//	    68     8  the first 8 bytes of SHA-256 over bytes 0..67
//	    76    32  HMAC-SHA-256 over bytes 0..75, under the check key
//	   108     n  the contents, sealed, with bytes 0..107 as additional data; the last 16 bytes are the tag
//
// Argon2id gives 64 bytes: the first 32 seal the contents, the last 32 are the check key.
//
// Two of those fields exist to say what went wrong, never to add protection. The digest at 68 catches a damaged
// header before any password work, so a rotten file is called damaged and not "wrong password". The check at 76
// tells a wrong password from damaged contents. Neither helps an attacker: both need the same Argon2id run a
// guess at the contents would need.
//
// The cost numbers are read from the file, so they are held to a fixed range before they are used: a file cannot
// make this process take a terabyte, and cannot be opened with a cost too low to be ours.
package vault

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

const (
	magic = "BERTHVLT"

	version         = 1
	kdfArgon2id     = 1
	cipherXChaCha20 = 1

	offVersion  = 8
	offKDF      = 9
	offCipher   = 10
	offThreads  = 11
	offTime     = 12
	offMemory   = 16
	offSavedAt  = 20
	offSalt     = 28
	offNonce    = 44
	offDigest   = 68
	offCheck    = 76
	headerLen   = 108
	saltLen     = 16
	nonceLen    = chacha20poly1305.NonceSizeX
	digestLen   = 8
	checkLen    = sha256.Size
	tagLen      = chacha20poly1305.Overhead
	derivedLen  = 64
	sealKeyLen  = chacha20poly1305.KeySize
	checkKeyLen = derivedLen - sealKeyLen
)

// The range a file's cost numbers must be in, and the most a list may hold.
const (
	MinTime      = 1
	MaxTime      = 16
	MinMemoryKiB = 64 * 1024   // 64 MiB
	MaxMemoryKiB = 1024 * 1024 // 1 GiB
	MinThreads   = 1
	MaxThreads   = 8
	MaxContents  = 8 * 1024 * 1024
)

// Params are the Argon2id cost numbers.
type Params struct {
	Time      uint32 // passes over the memory
	MemoryKiB uint32
	Threads   uint8
}

// Default is the cost a new list is sealed with until it is tuned on the machine it runs on (plan B13).
var Default = Params{Time: 3, MemoryKiB: 256 * 1024, Threads: 4}

func (p Params) inRange() bool {
	return p.Time >= MinTime && p.Time <= MaxTime &&
		p.MemoryKiB >= MinMemoryKiB && p.MemoryKiB <= MaxMemoryKiB &&
		p.Threads >= MinThreads && p.Threads <= MaxThreads
}

// Every way Open and Seal can refuse. Each is a different thing to tell the person at the keyboard.
var (
	ErrNotAList   = errors.New("vault: not a Berth list")
	ErrNewer      = errors.New("vault: made by a newer version of Berth, or damaged")
	ErrDamaged    = errors.New("vault: the file is damaged or was altered")
	ErrCost       = errors.New("vault: cost numbers outside the allowed range")
	ErrPassword   = errors.New("vault: wrong password")
	ErrNoPassword = errors.New("vault: no password given")
	ErrTooBig     = errors.New("vault: more than a list may hold")
	ErrWiped      = errors.New("vault: this key was wiped")
)

// Info is what a sealed file says about itself. It is only handed out by Open, after the file proved genuine.
type Info struct {
	SavedAt time.Time
	Params  Params
}

// Key is what the password became. It is held in memory while the app is unlocked, so that each save does not
// need the password again. It never leaves the process that made it.
type Key struct {
	params Params
	salt   [saltLen]byte
	seal   [sealKeyLen]byte
	check  [checkKeyLen]byte
	wiped  bool
}

// NewKey makes a key for a new list, or for a list whose password is being changed: a fresh salt, one Argon2id run.
func NewKey(password []byte, p Params) (*Key, error) {
	if len(password) == 0 {
		return nil, ErrNoPassword
	}
	if !p.inRange() {
		return nil, ErrCost
	}
	k := &Key{params: p}
	if _, err := rand.Read(k.salt[:]); err != nil {
		return nil, err
	}
	k.derive(password)
	return k, nil
}

func (k *Key) derive(password []byte) {
	out := argon2.IDKey(password, k.salt[:], k.params.Time, k.params.MemoryKiB, k.params.Threads, derivedLen)
	copy(k.seal[:], out[:sealKeyLen])
	copy(k.check[:], out[sealKeyLen:])
	clear(out)
}

// Wipe overwrites the key. A wiped key seals nothing.
func (k *Key) Wipe() {
	clear(k.seal[:])
	clear(k.check[:])
	clear(k.salt[:])
	k.wiped = true
}

// Seal returns the sealed file for these contents. Every call uses a fresh random nonce.
func (k *Key) Seal(contents []byte, savedAt time.Time) ([]byte, error) {
	var nonce [nonceLen]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	return k.sealWith(contents, savedAt, nonce[:])
}

func (k *Key) sealWith(contents []byte, savedAt time.Time, nonce []byte) ([]byte, error) {
	if k.wiped {
		return nil, ErrWiped
	}
	if len(contents) > MaxContents {
		return nil, ErrTooBig
	}
	out := make([]byte, headerLen, headerLen+len(contents)+tagLen)
	copy(out, magic)
	out[offVersion] = version
	out[offKDF] = kdfArgon2id
	out[offCipher] = cipherXChaCha20
	out[offThreads] = k.params.Threads
	binary.BigEndian.PutUint32(out[offTime:], k.params.Time)
	binary.BigEndian.PutUint32(out[offMemory:], k.params.MemoryKiB)
	binary.BigEndian.PutUint64(out[offSavedAt:], uint64(savedAt.Unix()))
	copy(out[offSalt:], k.salt[:])
	copy(out[offNonce:], nonce)
	digest := sha256.Sum256(out[:offDigest])
	copy(out[offDigest:], digest[:digestLen])
	copy(out[offCheck:], k.checkOf(out[:offCheck]))

	aead, err := chacha20poly1305.NewX(k.seal[:])
	if err != nil {
		return nil, err
	}
	return aead.Seal(out, nonce, contents, out[:headerLen]), nil
}

func (k *Key) checkOf(header []byte) []byte {
	mac := hmac.New(sha256.New, k.check[:])
	mac.Write(header)
	return mac.Sum(nil)
}

// Open checks a sealed file and returns its contents, the key for later saves, and what the file says about
// itself. Nothing in the file is acted on before it is checked: the layout and the cost range first, with no
// password work; then the password; then the contents.
func Open(password, sealed []byte) ([]byte, *Key, Info, error) {
	fail := func(err error) ([]byte, *Key, Info, error) { return nil, nil, Info{}, err }

	if len(sealed) < len(magic) || string(sealed[:len(magic)]) != magic {
		return fail(ErrNotAList)
	}
	if len(sealed) > headerLen+MaxContents+tagLen {
		return fail(ErrTooBig)
	}
	if len(sealed) < headerLen+tagLen {
		return fail(ErrDamaged)
	}
	if sealed[offVersion] > version {
		return fail(ErrNewer)
	}
	digest := sha256.Sum256(sealed[:offDigest])
	if subtle.ConstantTimeCompare(digest[:digestLen], sealed[offDigest:offCheck]) != 1 {
		return fail(ErrDamaged)
	}
	if sealed[offVersion] != version || sealed[offKDF] != kdfArgon2id || sealed[offCipher] != cipherXChaCha20 {
		return fail(ErrDamaged)
	}
	p := Params{
		Time:      binary.BigEndian.Uint32(sealed[offTime:]),
		MemoryKiB: binary.BigEndian.Uint32(sealed[offMemory:]),
		Threads:   sealed[offThreads],
	}
	if !p.inRange() {
		return fail(ErrCost)
	}
	if len(password) == 0 {
		return fail(ErrNoPassword)
	}

	k := &Key{params: p}
	copy(k.salt[:], sealed[offSalt:offNonce])
	k.derive(password)
	if !hmac.Equal(k.checkOf(sealed[:offCheck]), sealed[offCheck:headerLen]) {
		k.Wipe()
		return fail(ErrPassword)
	}
	aead, err := chacha20poly1305.NewX(k.seal[:])
	if err != nil {
		k.Wipe()
		return fail(err)
	}
	contents, err := aead.Open(nil, sealed[offNonce:offDigest], sealed[headerLen:], sealed[:headerLen])
	if err != nil {
		k.Wipe()
		return fail(ErrDamaged)
	}
	info := Info{SavedAt: time.Unix(int64(binary.BigEndian.Uint64(sealed[offSavedAt:])), 0).UTC(), Params: p}
	return contents, k, info, nil
}
