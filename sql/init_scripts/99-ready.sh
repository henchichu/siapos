# Runs last, and only if every earlier init script succeeded; the healthcheck requires this marker.
touch /var/lib/mysql/.siapos-ready
