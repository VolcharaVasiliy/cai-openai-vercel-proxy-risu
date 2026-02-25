@echo off
cd /d F:\cai-openai-vercel-proxy-prod-clean
set PATH=F:\DevTools\Portable\NodeJS;%PATH%
call npm.cmd run dev:local
