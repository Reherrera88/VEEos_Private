#!/bin/bash
# VEEos Deployment Script for 10.0.0.126
# Run on target machine: curl -sSL https://your-repo/deploy.sh | bash
# Or copy this script and run: bash deploy.sh

set -euo pipefail

VEEOS_DIR="/opt/VEEos"
REPO_URL="${1:-}"  # Optional: git repo URL

echo "========================================="
echo "  VEEos Deployment Script"
echo "========================================="

# Check if running as root (needed for Docker)
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (use sudo)"
   exit 1
fi

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi

# Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "Installing Docker Compose..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
fi

# Create deployment directory
mkdir -p "$VEEOS_DIR"
cd "$VEEOS_DIR"

# Clone or copy project
if [[ -n "$REPO_URL" ]]; then
    echo "Cloning from $REPO_URL..."
    git clone "$REPO_URL" .
else
    echo "Assuming project files are already in $VEEOS_DIR"
fi

# Check for Chrome profiles on host
echo "Checking for Chrome profiles..."
CHROME_DIRS=(
    "/home/$SUDO_USER/.config/google-chrome"
    "/root/.config/google-chrome"
    "/opt/google/chrome"
)

CHROME_HOST_DIR=""
for dir in "${CHROME_DIRS[@]}"; do
    if [[ -d "$dir" && -d "$dir/Profile 3" ]]; then
        CHROME_HOST_DIR="$dir"
        echo "Found Chrome profiles at: $CHROME_HOST_DIR"
        break
    fi
done

if [[ -z "$CHROME_HOST_DIR" ]]; then
    echo "WARNING: No Chrome Profile 3 found on host."
    echo "You need to create Chrome profiles with Google Flow access first."
    echo "Run: google-chrome --profile-directory=\"Profile 3\""
    echo "Then login to https://labs.google/fx/tools/flow"
fi

# Generate secure API token if not exists
if [[ ! -f "config/local.yaml" ]]; then
    echo "Creating config/local.yaml from template..."
    cp config/local.yaml.example config/local.yaml
    
    # Generate secure token
    TOKEN=$(openssl rand -hex 32)
    sed -i "s|CHANGE_ME_GENERATE_WITH: openssl rand -hex 32|$TOKEN|" config/local.yaml
    
    echo "========================================="
    echo "  GENERATED API TOKEN: $TOKEN"
    echo "  SAVE THIS TOKEN SECURELY!"
    echo "========================================="
    
    # Update Chrome host directory in config
    if [[ -n "$CHROME_HOST_DIR" ]]; then
        sed -i "s|/host-chrome|$CHROME_HOST_DIR|g" config/local.yaml
    fi
    
    echo "Please edit config/local.yaml with your account emails and Chrome profile names"
    echo "Then re-run this script to deploy."
    exit 0
fi

# Build and start
echo "Building Docker image..."
docker compose -f docker/docker-compose.yml build --no-cache

echo "Starting VEEos..."
docker compose -f docker/docker-compose.yml up -d

# Wait for health
echo "Waiting for health check..."
for i in {1..30}; do
    if curl -sf http://localhost:3456/health > /dev/null 2>&1; then
        echo "VEEos is healthy!"
        break
    fi
    sleep 2
done

# Show status
echo ""
echo "========================================="
echo "  VEEos Deployed Successfully!"
echo "========================================="
echo ""
echo "API Endpoint: http://10.0.0.126:3456"
echo "Health Check: http://10.0.0.126:3456/health"
echo "WebSocket:    ws://10.0.0.126:3456/ws"
echo ""
echo "API Token: $(grep 'token:' config/local.yaml | awk '{print $2}')"
echo ""
echo "Test with:"
echo "  curl -H \"Authorization: Bearer TOKEN\" http://10.0.0.126:3456/v1/accounts"
echo "  curl -H \"Authorization: Bearer TOKEN\" http://10.0.0.126:3456/v1/pool/status"
echo ""
echo "Logs: docker compose -f docker/docker-compose.yml logs -f veeos"