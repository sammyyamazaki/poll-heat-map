(function(){
  function setup(){
    try{
      var el = document.getElementById('splash');
      if(!el) return;
      function hide(){
        try{
          el.classList.add('hidden');
          setTimeout(function(){ try{ el.remove(); }catch(e){} }, 600);
        }catch(e){}
      }
      // Ensure we don't attach twice
      el.addEventListener('click', hide, { once: true });
      el.addEventListener('touchstart', hide, { once: true, passive: true });
      setTimeout(hide, 1200);
    }catch(e){}
  }
  if (document.readyState === 'complete') setup();
  else window.addEventListener('load', setup);
})();