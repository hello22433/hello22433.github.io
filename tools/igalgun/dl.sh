#!/bin/bash
# usage: dl.sh <publicDataPk> <out>
pk=$1; out=$2; UA="Mozilla/5.0"; J=$(mktemp)
curl -s -m 150 --retry 2 -A "$UA" -c $J -b $J "https://www.data.go.kr/data/$pk/fileData.do" -o /tmp/pg_$pk.html
args=$(grep -oE "fn_fileDataDown\('[^)]*\)" /tmp/pg_$pk.html | head -1 | grep -oE "'[^']*'" | tr -d "'" | tr '\n' ' ')
set -- $args
uddi=$2
r=$(curl -s -m 30 -A "$UA" -c $J -b $J -X POST "https://www.data.go.kr/tcs/dss/selectFileDataDownload.do" -H "X-Requested-With: XMLHttpRequest" --data "publicDataDetailPk=$uddi&publicDataPk=$pk&atchFileId=&fileDetailSn=1&publicDataTyCode=PR0051")
aid=$(echo "$r" | python3 -c "import json,sys;j=json.load(sys.stdin);print(j['atchFileId'],j['fileDetailSn'])" 2>/dev/null) || { echo "FAIL $r" | head -c 300; exit 1; }
set -- $aid
curl -s -m 300 --retry 3 -A "$UA" -c $J -b $J -L "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=$1&fileDetailSn=$2" -o "$out"
ls -la "$out"
