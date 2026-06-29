FROM mcr.microsoft.com/dotnet/sdk:8.0

# Install git + Node.js 22 (NodeSource) on top of the .NET SDK base
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @earendil-works/pi-coding-agent

WORKDIR /workspace