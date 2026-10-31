(() => {
  const status = document.getElementById('status');
  const map = new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/dark',center:[-100,39],zoom:3,attributionControl:true});
  map.addControl(new maplibregl.NavigationControl(),'top-right');
  let flashes=[];
  let generated=null;
  let selectedMinutes=60;
  const empty={type:'FeatureCollection',features:[]};
  const minutesOld=(f,now)=> (now-new Date(f.time).getTime())/60000;
  function render(){
    const now=Date.now();
    for(const n of [5,15,60]) document.getElementById('count'+n).textContent=flashes.filter(f=>minutesOld(f,now)>=0 && minutesOld(f,now)<=n).length.toLocaleString();
    const features=flashes.filter(f=>minutesOld(f,now)>=0 && minutesOld(f,now)<=selectedMinutes).map(f=>({type:'Feature',geometry:{type:'Point',coordinates:[f.lon,f.lat]},properties:{time:f.time,age:minutesOld(f,now)}}));
    if(map.getSource('flashes'))map.getSource('flashes').setData({type:'FeatureCollection',features});
    document.getElementById('updated').textContent=generated?'Dataset updated: '+new Date(generated).toLocaleString():'Waiting for first NOAA data run';
  }
  map.on('load',()=>{
    map.addSource('flashes',{type:'geojson',data:empty});
    map.addLayer({id:'flash-glow',type:'circle',source:'flashes',paint:{'circle-radius':8,'circle-blur':.65,'circle-color':['step',['get','age'],'#71e6ff',5,'#ffc26d',15,'#ff7e9b'],'circle-opacity':.4}});
    map.addLayer({id:'flash-dots',type:'circle',source:'flashes',paint:{'circle-radius':3,'circle-color':['step',['get','age'],'#71e6ff',5,'#ffc26d',15,'#ff7e9b'],'circle-opacity':.9}});
    map.on('click','flash-dots',e=>{const f=e.features?.[0];if(!f)return;new maplibregl.Popup().setLngLat(e.lngLat).setText('Approximate flash · '+new Date(f.properties.time).toLocaleString()).addTo(map);});
    render();
  });
  document.getElementById('window').addEventListener('change',e=>{selectedMinutes=Number(e.target.value);render();});
  async function load(){
    try{
      const response=await fetch('data/flashes.json?t='+Date.now(),{cache:'no-store'});
      if(!response.ok)throw Error('Dataset unavailable');
      const data=await response.json();
      flashes=Array.isArray(data.flashes)?data.flashes.filter(f=>Number.isFinite(f.lat)&&Number.isFinite(f.lon)&&!Number.isNaN(Date.parse(f.time))):[];
      generated=data.generated_at;
      status.textContent=generated?'NOAA DATA · '+new Date(generated).toLocaleTimeString():'NO DATA YET';
    }catch(err){status.textContent='DATA NOT AVAILABLE';console.error(err);}
    render();
  }
  load();
  setInterval(load,60000);
  setInterval(render,30000);
})();