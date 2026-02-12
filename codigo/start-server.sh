#!/bin/bash
cd /home/tomelin/rastreador

# Iniciar OSRM local primeiro
./start-osrm.sh

export HTTP_PORT=62000
export TCP_PORT=8877
export API_PORT=62000
exec node server/index.js
