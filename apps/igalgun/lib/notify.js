// 운영자 알림. RESEND_API_KEY와 NOTIFY_EMAIL이 있을 때만 메일을 보낸다.
// 실패해도 신청 접수는 성공으로 처리한다(알림은 부가 기능).
export async function notify(subject, body) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || '이사갈군 <onboarding@resend.dev>',
        to: [to],
        subject: `[이사갈군] ${subject}`,
        text: `${body}\n\n관리 화면: /admin`,
      }),
    });
    return res.ok;
  } catch (e) {
    console.error('notify failed', e);
    return false;
  }
}
