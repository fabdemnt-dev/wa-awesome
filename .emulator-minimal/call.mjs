const response = await fetch('http://127.0.0.1:5101/demo-minimal/asia-northeast1/helloWorld', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: {} })
});
const body = await response.text();
console.log(response.status, body);
if (!response.ok || !body.includes('"ok":true')) process.exitCode = 1;
