FROM python:3.14-slim

ARG TZ=Europe/Berlin
RUN ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime && echo "$TZ" > /etc/timezone

RUN apt-get update && apt-get -y install ffmpeg

WORKDIR /app

COPY app/requirements.txt ./
RUN pip install --no-cache-dir --no-warn-script-location -r requirements.txt

COPY app ./

ENTRYPOINT [ "/app/run_server.sh" ]
