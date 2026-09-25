(function () {
  try {
    var t = localStorage.getItem("v2p-theme");
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();
