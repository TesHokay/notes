document.querySelectorAll('.reactions').forEach(box => {
  const postId = box.dataset.postId;
  box.querySelectorAll('.react-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const emoji = btn.dataset.emoji;
      const res = await fetch(`/feed/posts/${postId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      if (!res.ok) return;
      const data = await res.json();
      btn.textContent = `${emoji} ${data.count || ''}`.trim();
      btn.classList.toggle('btn-primary', data.mine);
    });
  });
});
