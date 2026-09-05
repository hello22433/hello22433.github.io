/* 배포 설정
 *
 * realtimeEndpoint 를 비워 두면 실시간 도착 정보는 "샘플"로 동작한다.
 * Cloudflare Worker 프록시를 띄운 뒤(workers/subway-proxy/README.md 참고)
 * 그 주소를 여기에 적으면 실시간으로 바뀐다.
 *
 *   realtimeEndpoint: 'https://subway-proxy.<계정>.workers.dev'
 *
 * 이 파일에는 인증키를 적지 않는다. 키는 Worker 시크릿에만 둔다.
 * 임시로 시험해 볼 때는 주소창에 ?api=https://... 를 붙이면 된다.
 */
window.SUBWAY_CONFIG = {
  realtimeEndpoint: ''
};
