# Squid that opens TLS (ssl_bump), as company proxies do. Debian's squid-openssl has the TLS code
# that the stock squid package leaves out. Squid talks HTTP/1.1 to the browser.
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends squid-openssl openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /etc/squid/ssl \
  && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Squid test CA" \
    -keyout /etc/squid/ssl/ca.key -out /etc/squid/ssl/ca.crt \
  && cat /etc/squid/ssl/ca.key /etc/squid/ssl/ca.crt > /etc/squid/ssl/ca.pem \
  && /usr/lib/squid/security_file_certgen -c -s /var/spool/squid/ssl_db -M 4MB \
  && chown -R proxy:proxy /var/spool/squid /etc/squid/ssl
COPY squid.conf /etc/squid/squid.conf
EXPOSE 3128
CMD ["squid", "-N", "-d", "1"]
