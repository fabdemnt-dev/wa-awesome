const state = {
  mode: "poem", // 'poem' | 'haiku'
  editingId: { poem: null, haiku: null },
  forms: {
    poem: { name: "", words: "" },
    haiku: { name: "", words5: "", words7: "" },
  },
  sets: { poem: [], haiku: [] },
};

export default state;
