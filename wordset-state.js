const state = {
  mode: "poem", // 'poem' | 'haiku'
  editingId: { poem: null, haiku: null },
  expandedId: { poem: null, haiku: null }, // 「詳細を見る」で開いているセットのID
  forms: {
    poem: { name: "", words: "", creatorName: "", hasPassword: false, password: "", icon: null },
    haiku: { name: "", words5: "", words7: "", creatorName: "", hasPassword: false, password: "", icon: null },
  },
  sets: { poem: [], haiku: [] },
};

export default state;
