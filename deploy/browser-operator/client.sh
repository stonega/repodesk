#!/usr/bin/env bash
ssh_vps() {
  docker exec -i "$DEPLOY_CLIENT" ssh -T -i /tmp/key -p 22 \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/tmp/known_hosts -o ConnectTimeout=15 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 root@169.58.58.71 "$@"
}
