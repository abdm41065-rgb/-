'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, ImagePlus, LoaderCircle, Search, ShieldCheck, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';

type Product = { id:string; name:string; category:string; price:number; oldPrice?:number; stock:number; image:string; description:string; featured?:boolean };
type Match = { product:Product; similarity:number; visualSimilarity:number; textSimilarity:number };
type Confidence = 'strong'|'possible'|'uncertain';

let modelPromise:Promise<Awaited<ReturnType<typeof import('@tensorflow-models/mobilenet')['load']>>>|undefined;
const embeddingCache=new Map<string,Float32Array>();
let ocrWorkerPromise:Promise<Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>>|undefined;

const money=(value:number)=>new Intl.NumberFormat('ar-IQ').format(value)+' د.ع';

function loadImage(src:string,crossOrigin=false){
  return new Promise<HTMLImageElement>((resolve,reject)=>{
    const image=new Image();
    if(crossOrigin) image.crossOrigin='anonymous';
    image.decoding='async';
    const timer=window.setTimeout(()=>{image.src='';reject(new Error('timeout'))},7000);
    image.onload=()=>{window.clearTimeout(timer);resolve(image)};
    image.onerror=()=>{window.clearTimeout(timer);reject(new Error('image'))};
    image.src=src;
  });
}

async function loadCatalog(){
  const client=await getSupabase();
  const products:Product[]=[];
  for(let from=0;from<1000;from+=200){
    const {data,error}=await client.from('products').select('id,name,category,price,old_price,stock,image,description,featured').order('created_at',{ascending:false}).range(from,from+199);
    if(error) throw error;
    const rows=(data||[]).map(row=>({...row,price:Number(row.price),oldPrice:row.old_price?Number(row.old_price):undefined,stock:Number(row.stock)}) as Product);
    products.push(...rows);
    if(rows.length<200) break;
  }
  return products;
}

function confidenceFor(matches:Match[]):Confidence{
  if(!matches.length)return 'uncertain';
  const top=matches[0].similarity;
  const margin=top-(matches[1]?.similarity??0);
  if(top>=0.82&&margin>=0.08)return 'strong';
  if(top>=0.68&&margin>=0.06)return 'possible';
  return 'uncertain';
}

function cosineSimilarity(a:Float32Array,b:Float32Array){
  let dot=0;let left=0;let right=0;
  const length=Math.min(a.length,b.length);
  for(let index=0;index<length;index+=1){dot+=a[index]*b[index];left+=a[index]*a[index];right+=b[index]*b[index]}
  return dot/(Math.sqrt(left)*Math.sqrt(right)||1);
}

function normalizeText(value:string){
  return value.toLocaleLowerCase('ar')
    .replace(/vitamin\s*c|ascorbic/gi,' فيتامين سي ')
    .replace(/facial\s+cleanser|face\s+wash|cleanser/gi,' غسول ')
    .replace(/moisturi[sz]er|hydrating\s+cream/gi,' مرطب ')
    .replace(/sun\s*screen|sun\s+care|spf/gi,' واقي شمس ')
    .replace(/serum/gi,' سيروم ')
    .replace(/toner/gi,' تونر ')
    .replace(/cream/gi,' كريم ')
    .normalize('NFKD').replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}

function textSimilarity(ocrText:string,product:Product){
  const compactLatin=ocrText.toLowerCase().replace(/[^a-z]/g,'');
  const detectedTerms:string[]=[];
  if(/facia?l?cleanse?r?|facewash|cleanser/.test(compactLatin))detectedTerms.push('غسول');
  if(compactLatin.includes('serum'))detectedTerms.push('سيروم');
  if(compactLatin.includes('vitaminc')||compactLatin.includes('ascorbic'))detectedTerms.push('فيتامين');
  if(/moisturi[sz]er|hydratingcream/.test(compactLatin))detectedTerms.push('مرطب');
  if(/sunscreen|suncare|spf/.test(compactLatin))detectedTerms.push('واقي شمس');
  const haystack=` ${normalizeText(`${ocrText} ${detectedTerms.join(' ')}`)} `;
  const name=normalizeText(product.name);
  if(!haystack.trim()||!name)return 0;
  if(haystack.includes(` ${name} `)||haystack.includes(name))return 1;
  const meaningful=(value:string)=>value.split(' ').filter(token=>token.length>=3);
  const nameTokens=meaningful(name);
  const ocrTokens=new Set(meaningful(haystack));
  if(!nameTokens.length)return 0;
  const exact=nameTokens.filter(token=>ocrTokens.has(token)).length/nameTokens.length;
  const partial=nameTokens.filter(token=>[...ocrTokens].some(read=>read.includes(token)||token.includes(read))).length/nameTokens.length;
  const productTerms=['غسول','سيروم','فيتامين','مرطب','ترطيب','كريم','واقي','شمس','تونر','بلسم','شعر'];
  const sharedTerms=productTerms.filter(term=>nameTokens.includes(term)&&ocrTokens.has(term)).length;
  const termScore=sharedTerms>=2?0.94:sharedTerms===1?0.82:0;
  return Math.max(exact,partial*0.82,termScore);
}

async function readPackageText(src:string,onProgress:(progress:number)=>void){
  try{
    const {createWorker}=await import('tesseract.js');
    ocrWorkerPromise??=createWorker(['ara','eng'],1,{logger:message=>{if(message.status==='recognizing text')onProgress(Math.round((message.progress||0)*100))}});
    const worker=await ocrWorkerPromise;
    const {data}=await worker.recognize(src);
    return data.text.trim();
  }catch{return ''}
}

export function ImageSearch({onChoose}:{onChoose:(product:Product)=>void}){
  const [open,setOpen]=useState(false);
  const [preview,setPreview]=useState('');
  const [status,setStatus]=useState('');
  const [matches,setMatches]=useState<Match[]>([]);
  const [confidence,setConfidence]=useState<Confidence>('uncertain');
  const [recognizedText,setRecognizedText]=useState('');
  const [busy,setBusy]=useState(false);
  const inputRef=useRef<HTMLInputElement>(null);
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview)},[preview]);

  const close=()=>{if(!busy)setOpen(false)};
  const analyze=async(file?:File)=>{
    if(!file)return;
    if(!file.type.startsWith('image/')||file.size>8*1024*1024){setStatus('اختر صورة JPG أو PNG أو WebP بحجم أقل من 8 MB.');return}
    if(preview)URL.revokeObjectURL(preview);
    const objectUrl=URL.createObjectURL(file);
    setPreview(objectUrl);setMatches([]);setRecognizedText('');setBusy(true);setStatus('جارٍ قراءة اسم العبوة وتشغيل البحث البصري…');
    try{
      const [tf,mobilenet]=await Promise.all([import('@tensorflow/tfjs'),import('@tensorflow-models/mobilenet')]);
      await tf.ready();
      modelPromise??=mobilenet.load({version:2,alpha:0.5});
      const [model,queryImage,catalog,packageText]=await Promise.all([modelPromise,loadImage(objectUrl),loadCatalog(),readPackageText(objectUrl,progress=>setStatus(`جارٍ قراءة اسم العبوة… ${progress}%`))]);
      setRecognizedText(packageText.replace(/\s+/g,' ').slice(0,180));
      const queryTensor=model.infer(queryImage,true) as import('@tensorflow/tfjs').Tensor;
      const queryEmbedding=Float32Array.from(await queryTensor.data());
      queryTensor.dispose();
      const results:Match[]=[];
      let compared=0;
      for(let start=0;start<catalog.length;start+=5){
        setStatus(`جارٍ مقارنة الصورة مع المنتجات… ${Math.min(start+5,catalog.length)} من ${catalog.length}`);
        const batch=await Promise.all(catalog.slice(start,start+5).map(async product=>{
          try{
            let productEmbedding=embeddingCache.get(product.image);
            if(!productEmbedding){
              const productImage=await loadImage(product.image,true);
              const productTensor=model.infer(productImage,true) as import('@tensorflow/tfjs').Tensor;
              productEmbedding=Float32Array.from(await productTensor.data());
              productTensor.dispose();
              embeddingCache.set(product.image,productEmbedding);
            }
            const visualSimilarity=cosineSimilarity(queryEmbedding,productEmbedding);
            const nameSimilarity=textSimilarity(packageText,product);
            const similarity=nameSimilarity>=0.72?nameSimilarity*0.78+visualSimilarity*0.22:nameSimilarity>=0.35?nameSimilarity*0.58+visualSimilarity*0.42:visualSimilarity;
            compared+=1;
            return {product,similarity:Number(similarity),visualSimilarity,textSimilarity:nameSimilarity};
          }catch{return null}
        }));
        results.push(...batch.filter((item):item is Match=>item!==null));
      }
      results.sort((a,b)=>b.similarity-a.similarity);
      const best=results.slice(0,4);
      const nextConfidence=confidenceFor(best);
      setMatches(best);setConfidence(nextConfidence);
      setStatus(!results.length?'تعذرت قراءة صور المنتجات حاليًا. جرّب صورة أخرى.':nextConfidence==='strong'?`وجدنا مطابقة قوية بعد مقارنة ${compared} منتج.`:nextConfidence==='possible'?`وجدنا مطابقة محتملة بعد مقارنة ${compared} منتج. تأكد من الاسم والصورة.`:`لم نتمكن من تأكيد منتج واحد. هذه أكثر النتائج تشابهًا من بين ${compared} منتج.`);
    }catch{
      setStatus('تعذر تشغيل البحث بالصورة. تحقق من الإنترنت وحاول مرة أخرى.');
    }finally{setBusy(false)}
  };

  return <>
    <button onClick={()=>setOpen(true)} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 font-bold text-[#0b4b84] transition hover:bg-blue-100 md:h-11 md:px-4" aria-label="البحث عن منتج بالصورة"><Camera size={19}/><span className="hidden lg:inline">بحث بالصورة</span></button>
    {open&&createPortal(<div className="fixed inset-0 z-[70] grid place-items-end bg-slate-950/45 p-0 backdrop-blur-sm sm:place-items-center sm:p-5" role="presentation" onClick={close} onKeyDown={event=>{if(event.key==='Escape')close()}}><section role="dialog" aria-modal="true" aria-labelledby="image-search-title" onClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} className="max-h-[92vh] w-full overflow-y-auto rounded-t-[2rem] bg-white p-5 shadow-2xl sm:max-w-2xl sm:rounded-[2rem] sm:p-7"><div className="flex items-start justify-between gap-4"><div><span className="text-sm font-bold text-[#168bc5]">البحث البصري الذكي</span><h2 id="image-search-title" className="mt-1 text-2xl font-black text-[#0a315c]">ابحث عن المنتج بصورة</h2><p className="mt-2 text-sm leading-6 text-slate-500">صوّر العبوة بوضوح وسنعرض نفس المنتج أو الأقرب له بصريًا.</p></div><button onClick={close} disabled={busy} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-blue-50 text-[#0b4b84] disabled:opacity-40" aria-label="إغلاق"><X size={20}/></button></div>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={event=>void analyze(event.target.files?.[0])}/>
      <button onClick={()=>inputRef.current?.click()} disabled={busy} className="mt-6 flex min-h-44 w-full items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-blue-200 bg-blue-50/60 p-4 text-center transition hover:bg-blue-50 disabled:cursor-wait">{preview?<img src={preview} alt="الصورة المختارة للبحث" className="max-h-64 w-full rounded-xl object-contain"/>:<span><ImagePlus className="mx-auto text-[#168bc5]" size={38}/><b className="mt-3 block text-[#0a315c]">التقط صورة أو اخترها من الجهاز</b><small className="mt-1 block text-slate-500">JPG أو PNG أو WebP — حتى 8 MB</small></span>}</button>
      {status&&<div className="mt-4 flex items-center gap-2 rounded-xl bg-blue-50 px-4 py-3 text-sm font-bold text-[#17466f]">{busy?<LoaderCircle className="animate-spin" size={18}/>:<Search size={18}/>}<span>{status}</span></div>}
      {recognizedText&&<div className="mt-3 rounded-xl border border-blue-100 bg-white px-4 py-3 text-xs leading-5 text-slate-600"><b className="text-[#0b4b84]">النص المقروء من العبوة:</b> <span dir="auto">{recognizedText}</span></div>}
      {matches.length>0&&<div className="mt-5"><h3 className="mb-1 font-black text-[#0a315c]">{confidence==='strong'?'المنتج المطابق':confidence==='possible'?'مطابقة محتملة':'نتائج متشابهة'}</h3>{confidence!=='strong'&&<p className="mb-3 text-xs leading-5 text-amber-700">النتيجة غير مؤكدة. قارن اسم العبوة والصورة قبل اختيار المنتج.</p>}<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{matches.map(({product,similarity,textSimilarity:wordMatch},index)=><button key={product.id} onClick={()=>{onChoose(product);setOpen(false)}} className="overflow-hidden rounded-2xl border border-blue-100 bg-white text-right shadow-sm transition hover:-translate-y-1 hover:shadow-lg"><div className="relative aspect-square bg-blue-50"><img src={product.image} alt={product.name} className="h-full w-full object-cover"/><span className="absolute left-2 top-2 rounded-full bg-white/95 px-2 py-1 text-[11px] font-black text-[#0b4b84]">{index===0&&confidence==='strong'?'مطابقة قوية':`${Math.max(1,Math.round(similarity*100))}%`}</span>{wordMatch>=0.5&&<span className="absolute right-2 top-2 rounded-full bg-emerald-600 px-2 py-1 text-[10px] font-black text-white">تطابق الاسم</span>}</div><div className="p-3"><b className="line-clamp-2 block text-sm text-[#0a315c]">{product.name}</b><small className="mt-1 block text-[#168bc5]">{money(product.price)}</small></div></button>)}</div></div>}
      <div className="mt-5 flex items-start gap-2 text-xs leading-5 text-slate-500"><ShieldCheck className="mt-0.5 shrink-0 text-blue-500" size={16}/><span>تُحلل الصورة داخل جهازك ولا تُحفظ أو تُرفع إلى قاعدة البيانات. النتائج للعثور على المنتجات وليست تشخيصًا طبيًا.</span></div>
    </section></div>,document.body)}
  </>;
}
