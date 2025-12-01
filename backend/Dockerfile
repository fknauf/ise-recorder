FROM python:3.14-slim

RUN apt-get update \
    && apt-get -y upgrade \
    && apt-get -y install ffmpeg \
    && apt-get clean \
    && rm -rf /var/cache/apt/archives /var/lib/apt/lists/*

WORKDIR /app

COPY app/requirements.txt ./
RUN pip install --no-cache-dir --no-warn-script-location -r requirements.txt

COPY app ./

ENTRYPOINT [ "/app/run_server.sh" ]
