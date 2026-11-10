FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib \
    NUMBA_CACHE_DIR=/tmp/numba
RUN groupadd --gid 10001 researcher \
    && useradd --uid 10001 --gid researcher --create-home researcher \
    && mkdir -p /opt/research/output /reports \
    && chown -R researcher:researcher /opt/research /reports
WORKDIR /opt/research

FROM base AS research
COPY requirements-tested.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY --chown=researcher:researcher bridge.py ./bridge.py
USER researcher
ENTRYPOINT ["python", "/opt/research/bridge.py"]
CMD ["health"]

FROM base AS freqtrade
COPY requirements-freqtrade-tested.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY --chown=researcher:researcher freqtrade_dry_run.py freqtrade.spot.json CTSResearchStrategy.py ./
USER researcher
ENTRYPOINT ["python", "/opt/research/freqtrade_dry_run.py"]
CMD ["--validate-only"]

FROM base AS cryptofeed
# The pinned yapic-json release may require compilation on this platform.
RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY requirements-feed-tested.txt ./requirements.txt
RUN CC=gcc CXX=g++ python -m pip install --no-cache-dir -r requirements.txt
COPY --chown=researcher:researcher feed.py ./feed.py
USER researcher
ENTRYPOINT ["python", "/opt/research/feed.py"]
CMD ["--self-test", "--out", "/reports/feed-fixture.jsonl"]
