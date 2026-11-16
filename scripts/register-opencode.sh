#!/bin/bash
# Register VEEos as MCP server in OpenCode
# Run this on your LOCAL machine (where OpenCode runs)

set -euo pipefail

VEEOS_HOST="${1:-10.0.0.126}"
VEEOS_PORT="${2:-3456}"
API_TOKEN="${3:-}"

echo "========================================="
echo "  VEEos OpenCode MCP Registration"
echo "========================================="
echo ""

if [[ -z "$API_TOKEN" ]]; then
    echo "Usage: $0 <host> <port> <api_token>"
    echo "Example: $0 10.0.0.126 3456 abc123..."
    echo ""
    echo "Get token from: ssh root@$VEEOS_HOST \"grep token: /opt/VEEos/config/local.yaml\""
    exit 1
fi

# Test connection
echo "Testing VEEos connection..."
if curl -sf -H "Authorization: Bearer $API_TOKEN" "http://$VEEOS_HOST:$VEEOS_PORT/health" > /dev/null; then
    echo "✓ VEEos API reachable at http://$VEEOS_HOST:$VEEOS_PORT"
else
    echo "✗ Cannot reach VEEos API"
    exit 1
fi

# Get accounts to verify
ACCOUNTS=$(curl -sf -H "Authorization: Bearer $API_TOKEN" "http://$VEEOS_HOST:$VEEOS_PORT/v1/accounts" | jq -r '.accounts | length')
echo "✓ Found $ACCOUNTS configured accounts"

# OpenCode config path
OPENCODE_CONFIG_DIR="${HOME}/.config/opencode"
OPENCODE_MCP_FILE="${OPENCODE_CONFIG_DIR}/mcp.json"

mkdir -p "$OPENCODE_CONFIG_DIR"

# Backup existing config
if [[ -f "$OPENCODE_MCP_FILE" ]]; then
    cp "$OPENCODE_MCP_FILE" "${OPENCODE_MCP_FILE}.bak.$(date +%s)"
    echo "Backed up existing mcp.json"
fi

# Create or update MCP config
if [[ -f "$OPENCODE_MCP_FILE" ]]; then
    # Update existing - use jq to merge
    jq --arg host "$VEEOS_HOST" --arg port "$VEEOS_PORT" --arg token "$API_TOKEN" '
        .mcpServers.veeos = {
            "command": "docker",
            "args": ["exec", "-i", "veeos", "node", "src/index.js", "--mcp"],
            "env": {
                "VEEOS_MCP_MODE": "true",
                "VEEOS_API_HOST": $host,
                "VEEOS_API_PORT": ($port | tonumber),
                "VEEOS_API_TOKEN": $token
            }
        }
    ' "$OPENCODE_MCP_FILE" > "${OPENCODE_MCP_FILE}.tmp" && mv "${OPENCODE_MCP_FILE}.tmp" "$OPENCODE_MCP_FILE"
else
    # Create new
    cat > "$OPENCODE_MCP_FILE" <<EOF
{
  "mcpServers": {
    "veeos": {
      "command": "docker",
      "args": ["exec", "-i", "veeos", "node", "src/index.js", "--mcp"],
      "env": {
        "VEEOS_MCP_MODE": "true",
        "VEEOS_API_HOST": "$VEEOS_HOST",
        "VEEOS_API_PORT": $VEEOS_PORT,
        "VEEOS_API_TOKEN": "$API_TOKEN"
      }
    }
  }
}
EOF
fi

echo ""
echo "✓ Registered VEEos in OpenCode MCP config: $OPENCODE_MCP_FILE"
echo ""
echo "Next steps:"
echo "1. Restart OpenCode (or reload MCP servers)"
echo "2. Test with: veeos_status"
echo "3. Generate image: veeos_generate_image with prompt and auto_confirm=true"
echo ""
echo "Available MCP tools:"
echo "  - veeos_status"
echo "  - veeos_accounts"
echo "  - veeos_generate_image"
echo "  - veeos_generate_video"
echo "  - veeos_create_character"
echo "  - veeos_create_scene"
echo "  - veeos_grid_architect"
echo "  - veeos_use_tool"
echo "  - veeos_download_latest"
echo "  - veeos_queue_status"
echo "  - veeos_start_account"
echo "  - veeos_health_check"