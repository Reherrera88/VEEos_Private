#!/bin/bash
# VEEos Setup Verification Script
# Run on target machine (10.0.0.126) before deployment

set -euo pipefail

echo "========================================="
echo "  VEEos Setup Verification"
echo "========================================="
echo ""

# Check OS
echo "OS: $(lsb_release -d 2>/dev/null | cut -f2 || cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"')"
echo "Kernel: $(uname -r)"
echo "Architecture: $(uname -m)"
echo ""

# Check Docker
echo "--- Docker ---"
if command -v docker &> /dev/null; then
    echo "✓ Docker: $(docker --version)"
    if docker info &> /dev/null; then
        echo "✓ Docker daemon running"
    else
        echo "✗ Docker daemon not running (run: systemctl start docker)"
    fi
else
    echo "✗ Docker not installed"
fi

if command -v docker-compose &> /dev/null; then
    echo "✓ Docker Compose: $(docker-compose --version)"
elif docker compose version &> /dev/null; then
    echo "✓ Docker Compose (plugin): $(docker compose version)"
else
    echo "✗ Docker Compose not installed"
fi
echo ""

# Check Chrome
echo "--- Google Chrome ---"
CHROME_PATHS=(
    "/usr/bin/google-chrome-stable"
    "/usr/bin/google-chrome"
    "/opt/google/chrome/chrome"
)

CHROME_FOUND=""
for path in "${CHROME_PATHS[@]}"; do
    if [[ -x "$path" ]]; then
        CHROME_FOUND="$path"
        echo "✓ Chrome found at: $path"
        echo "  Version: $($path --version 2>/dev/null || echo 'unknown')"
        break
    fi
done

if [[ -z "$CHROME_FOUND" ]]; then
    echo "✗ Google Chrome not found"
    echo "  Install: wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg"
    echo "  echo \"deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main\" > /etc/apt/sources.list.d/google-chrome.list"
    echo "  apt-get update && apt-get install -y google-chrome-stable"
fi
echo ""

# Check Chrome profiles
echo "--- Chrome Profiles ---"
CHROME_USER_DATA_DIRS=(
    "/home/$SUDO_USER/.config/google-chrome"
    "/root/.config/google-chrome"
    "$HOME/.config/google-chrome"
)

for base_dir in "${CHROME_USER_DATA_DIRS[@]}"; do
    if [[ -d "$base_dir" ]]; then
        echo "Found Chrome user data: $base_dir"
        for profile in "$base_dir"/Profile*; do
            if [[ -d "$profile" ]]; then
                profile_name=$(basename "$profile")
                # Check if profile has cookies (signed in)
                if [[ -f "$profile/Cookies" || -f "$base_dir/Local State" ]]; then
                    echo "  ✓ $profile_name (has session data)"
                else
                    echo "  ○ $profile_name (empty)"
                fi
            fi
        done
    fi
done
echo ""

# Check ports
echo "--- Port Availability ---"
for port in 3456 9222 9223 9224 9225 9226 9227 9228 9229 9230; do
    if ss -tlnp 2>/dev/null | grep -q ":$port " || netstat -tlnp 2>/dev/null | grep -q ":$port "; then
        echo "⚠ Port $port: IN USE"
    else
        echo "✓ Port $port: FREE"
    fi
done
echo ""

# Check resources
echo "--- System Resources ---"
echo "CPU cores: $(nproc)"
echo "Memory: $(free -h | awk '/^Mem:/ {print $2}') total, $(free -h | awk '/^Mem:/ {print $7}') available"
echo "Disk (/opt): $(df -h /opt 2>/dev/null | awk 'NR==2 {print $4}') free || $(df -h / | awk 'NR==2 {print $4}') free"
echo ""

# Check network
echo "--- Network ---"
ip -4 addr show scope global | grep -oP '(?<=inet )\d+(\.\d+){3}' | while read ip; do
    echo "IP: $ip"
done
echo ""

echo "========================================="
echo "  Verification Complete"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Ensure you have Chrome profiles with Google Flow access"
echo "2. Run deploy.sh to install VEEos"
echo "3. Edit config/local.yaml with your account details"
echo "4. Re-run deploy.sh to start"