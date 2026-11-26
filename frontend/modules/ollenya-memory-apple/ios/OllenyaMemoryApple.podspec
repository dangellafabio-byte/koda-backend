Pod::Spec.new do |s|
  s.name = 'OllenyaMemoryApple'
  s.version = '0.1.0'
  s.summary = 'Local memory candidate'
  s.description = 'On-device memory proposals only'
  s.license = { :type => 'Proprietary' }
  s.author = 'Ollenya'
  s.homepage = 'https://github.com/dangellafabio-byte/koda-backend'
  s.platform = :ios, '15.1'
  s.source = { :path => '.' }
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.swift_version = '5.9'
end
