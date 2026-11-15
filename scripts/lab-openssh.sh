#!/usr/bin/env bash
# Real OpenSSH servers for the lab, in containers (plan B9). CI only: it needs a container engine.
#
#   lab-openssh.sh up     starts one container per line of toolchain/lab-images, each running three servers:
#                         an honest one, one whose only identity is an RSA key, and one that offers only a
#                         cipher the app refuses. Writes out/lab-openssh/ (keys made for this run, and `boxes`).
#   lab-openssh.sh down   removes them.
#
# Images are pinned by digest. A line whose digest is "unpinned" is not run: the script prints the digest and
# the OpenSSH version that image has today, and fails, so the line can be pinned by a person who has read them.
set -euo pipefail
cd "$(dirname "$0")/.."
dir="$PWD/out/lab-openssh"

down() { docker ps -aq --filter label=berth-lab | xargs -r docker rm -f >/dev/null; }

install_cmd() {
  case "$1" in
    apt) echo "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends openssh-server >/dev/null && useradd -m -s /bin/sh demo && usermod -p '*' demo" ;;
    apk) echo "apk add --no-cache -q openssh-server >/dev/null && adduser -D -s /bin/sh demo && sed -i 's/^demo:!/demo:*/' /etc/shadow" ;;
    *) echo "lab-openssh: unknown package tool $1" >&2; exit 1 ;;
  esac
}

[ "${1:-}" = down ] && { down; exit 0; }
[ "${1:-}" = up ] || { echo "usage: lab-openssh.sh up|down" >&2; exit 2; }

down
rm -rf "$dir" && mkdir -p "$dir/mount"
ssh-keygen -q -t ed25519 -N '' -C lab-host -f "$dir/mount/host_ed"
ssh-keygen -q -t rsa -b 3072 -N '' -C lab-host -f "$dir/mount/host_rsa"
ssh-keygen -q -t ed25519 -N '' -C lab-user -f "$dir/user"
cp "$dir/user.pub" "$dir/mount/authorized_keys"
cp "$dir/mount/host_ed.pub" "$dir/mount/host_rsa.pub" "$dir/"

unpinned=0
port=2200
: > "$dir/boxes"
while read -r name image tool kex; do
  case "$name" in ''|'#'*) continue ;; esac
  if [[ "$image" == *@sha256:unpinned ]]; then
    tag="${image%@*}"
    if docker pull -q "$tag" >/dev/null 2>&1 </dev/null; then
      digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$tag")"
      version="$(docker run --rm "$tag" sh -c "$(install_cmd "$tool") ; sshd -V 2>&1 | grep -o 'OpenSSH_[^ ,]*' | head -1" 2>&1 </dev/null | tail -1)"
      echo "lab-openssh: NOT PINNED: $name $tag is $digest today, with: $version"
    else
      echo "lab-openssh: NOT PINNED: $name $tag cannot be pulled"
    fi
    unpinned=1
    continue
  fi
  [ "$name" = survey ] && continue
  port=$((port + 10))
  common="-f /dev/null -e -o PidFile=none -o AuthorizedKeysFile=/lab/authorized_keys -o StrictModes=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=no"
  docker run -d --label berth-lab --name "berth-lab-$name" -v "$dir/mount:/lab:ro" \
    -p "127.0.0.1:$((port + 1)):2201" -p "127.0.0.1:$((port + 2)):2202" -p "127.0.0.1:$((port + 3)):2203" \
    "$image" sh -c "$(install_cmd "$tool") && mkdir -p /run/sshd /etc/lab && cp /lab/host_ed /lab/host_rsa /etc/lab/ && chmod 600 /etc/lab/* \
      && (sshd -V 2>&1 | grep -o 'OpenSSH_[^ ,]*' | head -1) > /version; \
      /usr/sbin/sshd -D -p 2201 -o HostKey=/etc/lab/host_ed $common & \
      /usr/sbin/sshd -D -p 2202 -o HostKey=/etc/lab/host_rsa $common & \
      /usr/sbin/sshd -D -p 2203 -o HostKey=/etc/lab/host_ed -o Ciphers=chacha20-poly1305@openssh.com $common & \
      wait" >/dev/null </dev/null
  echo "$name 127.0.0.1:$((port + 1)) 127.0.0.1:$((port + 2)) 127.0.0.1:$((port + 3)) $kex" >> "$dir/boxes.pending"
done < toolchain/lab-images
[ "$unpinned" = 0 ] || { echo "lab-openssh: pin the lines above in toolchain/lab-images" >&2; down; exit 1; }

# Wait until every server says its first line, then note which OpenSSH it is.
while read -r name a b c kex; do
  for addr in "$a" "$b" "$c"; do
    ok=0
    for _ in $(seq 1 120); do
      if (exec 3<>"/dev/tcp/${addr%:*}/${addr#*:}" && head -c 4 <&3 | grep -q SSH-) 2>/dev/null; then ok=1; break; fi
      sleep 1
    done
    [ "$ok" = 1 ] || { echo "lab-openssh: $name at $addr never answered" >&2; docker logs "berth-lab-$name" 2>&1 | tail -20 >&2; exit 1; }
  done
  version="$(docker exec "berth-lab-$name" cat /version | tr -d '\r' | tr ' ' '_')"
  echo "$name $a $b $c $kex $version" >> "$dir/boxes"
  echo "lab-openssh: $name is up: $version"
done < "$dir/boxes.pending"
rm -f "$dir/boxes.pending"
oldest="$(awk '$1=="oldest"{print $6}' "$dir/boxes")"
[[ "$oldest" == OpenSSH_8.9* ]] || { echo "lab-openssh: the oldest server is $oldest, not OpenSSH 8.9" >&2; exit 1; }
chmod -R a+rX "$dir"
