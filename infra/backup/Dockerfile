FROM postgres:16-alpine
RUN apk add --no-cache rclone gnupg curl bash tzdata
ENV TZ=Europe/Tirane
COPY backup.sh restore-test.sh restore.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
