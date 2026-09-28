update public.products set category = 'مرطبات' where category in ('الترطيب', 'مرطبات');
update public.products set category = 'غسولات' where category in ('التنظيف', 'غسولات');
update public.products set category = 'سيرومات' where category in ('السيرومات', 'سيرومات');
update public.products set category = 'العناية بالشعر' where category = 'الشعر';
update public.products set category = 'العناية بالأظافر' where category in ('الأظافر', 'الاظافر');
update public.products set category = 'العناية بالأطفال' where category in ('الأطفال', 'الاطفال');
update public.products set category = 'العناية بالجسم' where category = 'الجسم';

delete from public.store_categories;

insert into public.store_categories (name, sort_order) values
  ('العناية بالبشرة', 10),
  ('غسولات', 20),
  ('مرطبات', 30),
  ('واقيات الشمس', 40),
  ('سيرومات', 50),
  ('مزيلات المكياج', 60),
  ('تونر', 70),
  ('العناية بالشعر', 80),
  ('العناية بالأظافر', 90),
  ('العناية بالأطفال', 100),
  ('العناية بالجسم', 110);
