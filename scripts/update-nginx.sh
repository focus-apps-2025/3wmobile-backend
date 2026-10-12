#!/bin/bash
# Run this on EC2 to update Nginx for large analytics payloads
# Usage: sudo bash update-nginx.sh

NGINX_CONF="/etc/nginx/sites-available/default"

# Check if the config already has our optimizations
if grep -q "proxy_buffer_size 128k" "$NGINX_CONF" 2>/dev/null; then
  echo "✅ Nginx already optimized. Skipping."
  exit 0
fi

# Backup existing config
sudo cp "$NGINX_CONF" "${NGINX_CONF}.backup.$(date +%Y%m%d%H%M%S)"

# Add performance directives inside the server block
sudo sed -i '/location.*\/ {/,/}/ {
  /proxy_pass/ a\
        # --- Analytics Performance Optimizations ---\
        proxy_buffers 16 64k;\
        proxy_buffer_size 128k;\
        proxy_busy_buffers_size 128k;\
        proxy_connect_timeout 300s;\
        proxy_send_timeout 300s;\
        proxy_read_timeout 300s;\
        send_timeout 300s;
}' "$NGINX_CONF"

# Add gzip settings in the http context
if ! grep -q "gzip_types application/json" /etc/nginx/nginx.conf 2>/dev/null; then
  sudo sed -i '/http {/a\
    # --- Gzip Compression ---\
    gzip on;\
    gzip_vary on;\
    gzip_proxied any;\
    gzip_comp_level 6;\
    gzip_min_length 1000;\
    gzip_types application/json text/plain application/javascript text/css text/xml application/xml;' /etc/nginx/nginx.conf
fi

# Test and reload
sudo nginx -t && sudo systemctl reload nginx

echo "✅ Nginx optimized for analytics payloads!"
echo "   - Buffer size: 128k"
echo "   - Timeout: 300s"  
echo "   - Gzip: enabled for JSON"
