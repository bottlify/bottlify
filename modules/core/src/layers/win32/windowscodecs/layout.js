/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Windows Imaging Component's interfaces and GUIDs, as wincodec.h
 * publishes them: each interface's IID, the one it derives from and its own
 * methods in vtable order with the bytes a stdcall call to each pops (`this`
 * and a double eight). Data, not behaviour: `objects.js` gives the methods
 * their meaning.
 */

/**
 * @typedef {{ iid: string, base: string, methods: [string, number][] }} InterfaceLayout
 */

/** @type {Record<string, InterfaceLayout>} */
export const INTERFACES = {
    IStream: {
        iid: '{0000000C-0000-0000-C000-000000000046}', base: 'IUnknown',
        methods: [
            ['Read', 16], ['Write', 16], ['Seek', 20], ['SetSize', 12], ['CopyTo', 24],
            ['Commit', 8], ['Revert', 4], ['LockRegion', 24], ['UnlockRegion', 24], ['Stat', 12],
            ['Clone', 8]
        ] },
    IWICColorContext: {
        iid: '{3C613A02-34B2-44EA-9A7C-45AEA9C6FD6D}', base: 'IUnknown',
        methods: [
            ['InitializeFromFilename', 8], ['InitializeFromMemory', 12],
            ['InitializeFromExifColorSpace', 8], ['GetType', 8], ['GetProfileBytes', 16],
            ['GetExifColorSpace', 8]
        ] },
    IWICBitmapSource: {
        iid: '{00000120-A8F2-4877-BA0A-FD2B6645FB94}', base: 'IUnknown',
        methods: [
            ['GetSize', 12], ['GetPixelFormat', 8], ['GetResolution', 12], ['CopyPalette', 8],
            ['CopyPixels', 20]
        ] },
    IWICBitmapLock: {
        iid: '{00000123-A8F2-4877-BA0A-FD2B6645FB94}', base: 'IUnknown',
        methods: [
            ['GetSize', 12], ['GetStride', 8], ['GetDataPointer', 12], ['GetPixelFormat', 8]
        ] },
    IWICBitmapFlipRotator: {
        iid: '{5009834F-2D6A-41CE-9E1B-17C5AFF7A782}', base: 'IWICBitmapSource',
        methods: [
            ['Initialize', 12]
        ] },
    IWICBitmap: {
        iid: '{00000121-A8F2-4877-BA0A-FD2B6645FB94}', base: 'IWICBitmapSource',
        methods: [
            ['Lock', 16], ['SetPalette', 8], ['SetResolution', 20]
        ] },
    IWICPalette: {
        iid: '{00000040-A8F2-4877-BA0A-FD2B6645FB94}', base: 'IUnknown',
        methods: [
            ['InitializePredefined', 12], ['InitializeCustom', 12], ['InitializeFromBitmap', 16],
            ['InitializeFromPalette', 8], ['GetType', 8], ['GetColorCount', 8], ['GetColors', 16],
            ['IsBlackWhite', 8], ['IsGrayscale', 8], ['HasAlpha', 8]
        ] },
    IWICComponentInfo: {
        iid: '{23BC3F0A-698B-4357-886B-F24D50671334}', base: 'IUnknown',
        methods: [
            ['GetComponentType', 8], ['GetCLSID', 8], ['GetSigningStatus', 8], ['GetAuthor', 16],
            ['GetVendorGUID', 8], ['GetVersion', 16], ['GetSpecVersion', 16],
            ['GetFriendlyName', 16]
        ] },
    IWICMetadataQueryReader: {
        iid: '{30989668-E1C9-4597-B395-458EEDB808DF}', base: 'IUnknown',
        methods: [
            ['GetContainerFormat', 8], ['GetLocation', 16], ['GetMetadataByName', 12],
            ['GetEnumerator', 8]
        ] },
    IWICBitmapFrameDecode: {
        iid: '{3B16811B-6A43-4EC9-A813-3D930C13B940}', base: 'IWICBitmapSource',
        methods: [
            ['GetMetadataQueryReader', 8], ['GetColorContexts', 16], ['GetThumbnail', 8]
        ] },
    IWICPixelFormatInfo: {
        iid: '{E8EDA601-3D48-431A-AB44-69059BE88BBE}', base: 'IWICComponentInfo',
        methods: [
            ['GetFormatGUID', 8], ['GetColorContext', 8], ['GetBitsPerPixel', 8],
            ['GetChannelCount', 8], ['GetChannelMask', 20]
        ] },
    IWICPixelFormatInfo2: {
        iid: '{A9DB33A2-AF5F-43C7-B679-74F5984B5AA4}', base: 'IWICPixelFormatInfo',
        methods: [
            ['SupportsTransparency', 8], ['GetNumericRepresentation', 8]
        ] },
    IWICBitmapCodecInfo: {
        iid: '{E87A44C4-B76E-4C47-8B09-298EB12A2714}', base: 'IWICComponentInfo',
        methods: [
            ['GetContainerFormat', 8], ['GetPixelFormats', 16], ['GetColorManagementVersion', 16],
            ['GetDeviceManufacturer', 16], ['GetDeviceModels', 16], ['GetMimeTypes', 16],
            ['GetFileExtensions', 16], ['DoesSupportAnimation', 8], ['DoesSupportChromaKey', 8],
            ['DoesSupportLossless', 8], ['DoesSupportMultiframe', 8], ['MatchesMimeType', 12]
        ] },
    IWICBitmapDecoderInfo: {
        iid: '{D8CD007F-D08F-4191-9BFC-236EA7F0E4B5}', base: 'IWICBitmapCodecInfo',
        methods: [
            ['GetPatterns', 20], ['MatchesPattern', 12], ['CreateInstance', 8]
        ] },
    IWICBitmapDecoder: {
        iid: '{9EDDE9E7-8DEE-47EA-99DF-E6FAF2ED44BF}', base: 'IUnknown',
        methods: [
            ['QueryCapability', 12], ['Initialize', 12], ['GetContainerFormat', 8],
            ['GetDecoderInfo', 8], ['CopyPalette', 8], ['GetMetadataQueryReader', 8],
            ['GetPreview', 8], ['GetColorContexts', 16], ['GetThumbnail', 8], ['GetFrameCount', 8],
            ['GetFrame', 12]
        ] },
    IWICBitmapFrameEncode: {
        iid: '{00000105-A8F2-4877-BA0A-FD2B6645FB94}', base: 'IUnknown',
        methods: [
            ['Initialize', 8], ['SetSize', 12], ['SetResolution', 20], ['SetPixelFormat', 8],
            ['SetColorContexts', 12], ['SetPalette', 8], ['SetThumbnail', 8], ['WritePixels', 20],
            ['WriteSource', 12], ['Commit', 4], ['GetMetadataQueryWriter', 8]
        ] },
    IWICBitmapEncoderInfo: {
        iid: '{94C9B4EE-A09F-4F92-8A1E-4A9BCE7E76FB}', base: 'IWICBitmapCodecInfo',
        methods: [
            ['CreateInstance', 8]
        ] },
    IWICBitmapEncoder: {
        iid: '{00000103-A8F2-4877-BA0A-FD2B6645FB94}', base: 'IUnknown',
        methods: [
            ['Initialize', 12], ['GetContainerFormat', 8], ['GetEncoderInfo', 8],
            ['SetColorContexts', 12], ['SetPalette', 8], ['SetThumbnail', 8], ['SetPreview', 8],
            ['CreateNewFrame', 12], ['Commit', 4], ['GetMetadataQueryWriter', 8]
        ] },
    IWICFormatConverter: {
        iid: '{00000301-A8F2-4877-BA0A-FD2B6645FB94}', base: 'IWICBitmapSource',
        methods: [
            ['Initialize', 32], ['CanConvert', 16]
        ] },
    IWICFormatConverterInfo: {
        iid: '{9F34FB65-13F4-4F15-BC57-3726B5E53D9F}', base: 'IWICComponentInfo',
        methods: [
            ['GetPixelFormats', 16], ['CreateInstance', 8]
        ] },
    IWICStream: {
        iid: '{135FF860-22B7-4DDF-B0F6-218F4F299A43}', base: 'IStream',
        methods: [
            ['InitializeFromIStream', 8], ['InitializeFromFilename', 12],
            ['InitializeFromMemory', 12], ['InitializeFromIStreamRegion', 24]
        ] },
    IWICBitmapScaler: {
        iid: '{00000302-A8F2-4877-BA0A-FD2B6645FB94}', base: 'IWICBitmapSource',
        methods: [
            ['Initialize', 20]
        ] },
    IWICBitmapClipper: {
        iid: '{E4FBCF03-223D-4E81-9333-D635556DD1B5}', base: 'IWICBitmapSource',
        methods: [
            ['Initialize', 12]
        ] },
    IWICColorTransform: {
        iid: '{B66F034F-D0E2-40AB-B436-6DE39E321A94}', base: 'IWICBitmapSource',
        methods: [
            ['Initialize', 20]
        ] },
    IWICImagingFactory: {
        iid: '{EC5EC8A9-C395-4314-9C77-54D7A935FF70}', base: 'IUnknown',
        methods: [
            ['CreateDecoderFromFilename', 24], ['CreateDecoderFromStream', 20],
            ['CreateDecoderFromFileHandle', 20], ['CreateComponentInfo', 12],
            ['CreateDecoder', 16], ['CreateEncoder', 16], ['CreatePalette', 8],
            ['CreateFormatConverter', 8], ['CreateBitmapScaler', 8], ['CreateBitmapClipper', 8],
            ['CreateBitmapFlipRotator', 8], ['CreateStream', 8], ['CreateColorContext', 8],
            ['CreateColorTransformer', 8], ['CreateBitmap', 24], ['CreateBitmapFromSource', 16],
            ['CreateBitmapFromSourceRect', 28], ['CreateBitmapFromMemory', 32],
            ['CreateBitmapFromHBITMAP', 20], ['CreateBitmapFromHICON', 12],
            ['CreateComponentEnumerator', 16], ['CreateFastMetadataEncoderFromDecoder', 12],
            ['CreateFastMetadataEncoderFromFrameDecode', 12], ['CreateQueryWriter', 16],
            ['CreateQueryWriterFromReader', 16]
        ] },
    IWICImagingFactory2: {
        iid: '{7B816B45-1996-4476-B132-DE9E247C8AF0}', base: 'IWICImagingFactory',
        methods: [
            ['CreateImageEncoder', 12]
        ] },
    IWICComponentFactory: {
        iid: '{412D0C3A-9650-44FA-AF5B-DD2A06C8E8FB}', base: 'IWICImagingFactory',
        methods: [
            ['CreateMetadataReader', 24], ['CreateMetadataReaderFromContainer', 24],
            ['CreateMetadataWriter', 20], ['CreateMetadataWriterFromReader', 16],
            ['CreateQueryReaderFromBlockReader', 12], ['CreateQueryWriterFromBlockWriter', 12],
            ['CreateEncoderPropertyBag', 16]
        ] },
};

/** The GUIDs, by their names in wincodec.h, braced and in capitals. */
export const GUID = Object.freeze({
    PixelFormatDontCare: '{6FDDC324-4E03-4BFE-B185-3D77768DC900}',
    PixelFormat1bppIndexed: '{6FDDC324-4E03-4BFE-B185-3D77768DC901}',
    PixelFormat2bppIndexed: '{6FDDC324-4E03-4BFE-B185-3D77768DC902}',
    PixelFormat4bppIndexed: '{6FDDC324-4E03-4BFE-B185-3D77768DC903}',
    PixelFormat8bppIndexed: '{6FDDC324-4E03-4BFE-B185-3D77768DC904}',
    PixelFormatBlackWhite: '{6FDDC324-4E03-4BFE-B185-3D77768DC905}',
    PixelFormat2bppGray: '{6FDDC324-4E03-4BFE-B185-3D77768DC906}',
    PixelFormat4bppGray: '{6FDDC324-4E03-4BFE-B185-3D77768DC907}',
    PixelFormat8bppGray: '{6FDDC324-4E03-4BFE-B185-3D77768DC908}',
    PixelFormat16bppGray: '{6FDDC324-4E03-4BFE-B185-3D77768DC90B}',
    PixelFormat8bppAlpha: '{E6CD0116-EEBA-4161-AA85-27DD9FB3A895}',
    PixelFormat16bppBGR555: '{6FDDC324-4E03-4BFE-B185-3D77768DC909}',
    PixelFormat16bppBGR565: '{6FDDC324-4E03-4BFE-B185-3D77768DC90A}',
    PixelFormat16bppBGRA5551: '{05EC7C2B-F1E6-4961-AD46-E1CC810A87D2}',
    PixelFormat24bppBGR: '{6FDDC324-4E03-4BFE-B185-3D77768DC90C}',
    PixelFormat24bppRGB: '{6FDDC324-4E03-4BFE-B185-3D77768DC90D}',
    PixelFormat32bppBGR: '{6FDDC324-4E03-4BFE-B185-3D77768DC90E}',
    PixelFormat32bppBGRA: '{6FDDC324-4E03-4BFE-B185-3D77768DC90F}',
    PixelFormat32bppPBGRA: '{6FDDC324-4E03-4BFE-B185-3D77768DC910}',
    PixelFormat32bppRGB: '{D98C6B95-3EFE-47D6-BB25-EB1748AB0CF1}',
    PixelFormat32bppRGBA: '{F5C7AD2D-6A8D-43DD-A7A8-A29935261AE9}',
    PixelFormat32bppPRGBA: '{3CC4A650-A527-4D37-A916-3142C7EBEDBA}',
    PixelFormat32bppGrayFloat: '{6FDDC324-4E03-4BFE-B185-3D77768DC911}',
    PixelFormat48bppRGB: '{6FDDC324-4E03-4BFE-B185-3D77768DC915}',
    PixelFormat48bppBGR: '{E605A384-B468-46CE-BB2E-36F180E64313}',
    PixelFormat64bppRGB: '{A1182111-186D-4D42-BC6A-9C8303A8DFF9}',
    PixelFormat64bppRGBA: '{6FDDC324-4E03-4BFE-B185-3D77768DC916}',
    PixelFormat64bppBGRA: '{1562FF7C-D352-46F9-979E-42976B792246}',
    PixelFormat64bppPRGBA: '{6FDDC324-4E03-4BFE-B185-3D77768DC917}',
    PixelFormat64bppPBGRA: '{8C518E8E-A4EC-468B-AE70-C9A35A9C5530}',
    PixelFormat16bppGrayFixedPoint: '{6FDDC324-4E03-4BFE-B185-3D77768DC913}',
    PixelFormat32bppBGR101010: '{6FDDC324-4E03-4BFE-B185-3D77768DC914}',
    PixelFormat48bppRGBFixedPoint: '{6FDDC324-4E03-4BFE-B185-3D77768DC912}',
    PixelFormat48bppBGRFixedPoint: '{49CA140E-CAB6-493B-9DDF-60187C37532A}',
    PixelFormat96bppRGBFixedPoint: '{6FDDC324-4E03-4BFE-B185-3D77768DC918}',
    PixelFormat96bppRGBFloat: '{E3FED78F-E8DB-4ACF-84C1-E97F6136B327}',
    PixelFormat128bppRGBAFloat: '{6FDDC324-4E03-4BFE-B185-3D77768DC919}',
    PixelFormat128bppPRGBAFloat: '{6FDDC324-4E03-4BFE-B185-3D77768DC91A}',
    PixelFormat128bppRGBFloat: '{6FDDC324-4E03-4BFE-B185-3D77768DC91B}',
    PixelFormat32bppCMYK: '{6FDDC324-4E03-4BFE-B185-3D77768DC91C}',
    PixelFormat64bppRGBAFixedPoint: '{6FDDC324-4E03-4BFE-B185-3D77768DC91D}',
    PixelFormat64bppBGRAFixedPoint: '{356DE33C-54D2-4A23-BB04-9B7BF9B1D42D}',
    PixelFormat64bppRGBFixedPoint: '{6FDDC324-4E03-4BFE-B185-3D77768DC940}',
    PixelFormat128bppRGBAFixedPoint: '{6FDDC324-4E03-4BFE-B185-3D77768DC91E}',
    PixelFormat128bppRGBFixedPoint: '{6FDDC324-4E03-4BFE-B185-3D77768DC941}',
    PixelFormat64bppRGBAHalf: '{6FDDC324-4E03-4BFE-B185-3D77768DC93A}',
    PixelFormat64bppPRGBAHalf: '{58AD26C2-C623-4D9D-B320-387E49F8C442}',
    PixelFormat64bppRGBHalf: '{6FDDC324-4E03-4BFE-B185-3D77768DC942}',
    PixelFormat48bppRGBHalf: '{6FDDC324-4E03-4BFE-B185-3D77768DC93B}',
    PixelFormat32bppRGBE: '{6FDDC324-4E03-4BFE-B185-3D77768DC93D}',
    PixelFormat16bppGrayHalf: '{6FDDC324-4E03-4BFE-B185-3D77768DC93E}',
    PixelFormat32bppGrayFixedPoint: '{6FDDC324-4E03-4BFE-B185-3D77768DC93F}',
    PixelFormat32bppRGBA1010102: '{25238D72-FCF9-4522-B514-5578E5AD55E0}',
    PixelFormat32bppRGBA1010102XR: '{00DE6B9A-C101-434B-B502-D0165EE1122C}',
    PixelFormat32bppR10G10B10A2: '{604E1BB5-8A3C-4B65-B11C-BC0B8DD75B7F}',
    PixelFormat32bppR10G10B10A2HDR10: '{9C215C5D-1ACC-4F0E-A4BC-70FB3AE8FD28}',
    PixelFormat64bppCMYK: '{6FDDC324-4E03-4BFE-B185-3D77768DC91F}',
    PixelFormat24bpp3Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC920}',
    PixelFormat32bpp4Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC921}',
    PixelFormat40bpp5Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC922}',
    PixelFormat48bpp6Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC923}',
    PixelFormat56bpp7Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC924}',
    PixelFormat64bpp8Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC925}',
    PixelFormat48bpp3Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC926}',
    PixelFormat64bpp4Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC927}',
    PixelFormat80bpp5Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC928}',
    PixelFormat96bpp6Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC929}',
    PixelFormat112bpp7Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC92A}',
    PixelFormat128bpp8Channels: '{6FDDC324-4E03-4BFE-B185-3D77768DC92B}',
    PixelFormat40bppCMYKAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC92C}',
    PixelFormat80bppCMYKAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC92D}',
    PixelFormat32bpp3ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC92E}',
    PixelFormat40bpp4ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC92F}',
    PixelFormat48bpp5ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC930}',
    PixelFormat56bpp6ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC931}',
    PixelFormat64bpp7ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC932}',
    PixelFormat72bpp8ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC933}',
    PixelFormat64bpp3ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC934}',
    PixelFormat80bpp4ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC935}',
    PixelFormat96bpp5ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC936}',
    PixelFormat112bpp6ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC937}',
    PixelFormat128bpp7ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC938}',
    PixelFormat144bpp8ChannelsAlpha: '{6FDDC324-4E03-4BFE-B185-3D77768DC939}',
    PixelFormat8bppY: '{91B4DB54-2DF9-42F0-B449-2909BB3DF88E}',
    PixelFormat8bppCb: '{1339F224-6BFE-4C3E-9302-E4F3A6D0CA2A}',
    PixelFormat8bppCr: '{B8145053-2116-49F0-8835-ED844B205C51}',
    PixelFormat16bppCbCr: '{FF95BA6E-11E0-4263-BB45-01721F3460A4}',
    PixelFormat16bppYQuantizedDctCoefficients: '{A355F433-48E8-4A42-84D8-E2AA26CA80A4}',
    PixelFormat16bppCbQuantizedDctCoefficients: '{D2C4FF61-56A5-49C2-8B5C-4C1925964837}',
    PixelFormat16bppCrQuantizedDctCoefficients: '{2FE354F0-1680-42D8-9231-E73C0565BFC1}',
    CLSID_ImagingFactory: '{CACAF262-9370-4615-A13B-9F5539DA4C0A}',
    CLSID_BmpDecoder: '{6B462062-7CBF-400D-9FDB-813DD10F2778}',
    CLSID_PngDecoder: '{389EA17B-5078-4CDE-B6EF-25C15175C751}',
    CLSID_IcoDecoder: '{C61BFCDF-2E0F-4AAD-A8D7-E06BAFEBCDFE}',
    CLSID_JpegDecoder: '{9456A480-E88B-43EA-9E73-0B2D9B71B1CA}',
    CLSID_GifDecoder: '{381DDA3C-9CE9-4834-A23E-1F98F8FC52BE}',
    CLSID_TiffDecoder: '{B54E85D9-FE23-499F-8B88-6ACEA713752B}',
    CLSID_WmpDecoder: '{A26CEC36-234C-4950-AE16-E34AACE71D0D}',
    CLSID_DdsDecoder: '{9053699F-A341-429D-9E90-EE437CF80C73}',
    CLSID_BmpEncoder: '{69BE8BB4-D66D-47C8-865A-ED1589433782}',
    CLSID_PngEncoder: '{27949969-876A-41D7-9447-568F6A35A4DC}',
    CLSID_JpegEncoder: '{1A34F5C1-4A5A-46DC-B644-1F4567E7A676}',
    CLSID_GifEncoder: '{114F5598-0B22-40A0-86A1-C83EA495ADBD}',
    CLSID_TiffEncoder: '{0131BE10-2001-4C5F-A9B0-CC88FAB64CE8}',
    CLSID_WmpEncoder: '{AC4CE3CB-E1C1-44CD-8215-5A1665509EC2}',
    CLSID_DdsEncoder: '{A61DDE94-66CE-4AC1-881B-71680588895E}',
    CLSID_AdngDecoder: '{981D9411-909E-42A7-8F5D-A747FF052EDB}',
    CLSID_JpegQualcommPhoneEncoder: '{68ED5C62-F534-4979-B2B3-686A12B2B34C}',
    CLSID_HeifDecoder: '{E9A4A80A-44FE-4DE4-8971-7150B10A5199}',
    CLSID_HeifEncoder: '{0DBECEC1-9EB3-4860-9C6F-DDBE86634575}',
    CLSID_WebpDecoder: '{7693E886-51C9-4070-8419-9F70738EC8FA}',
    CLSID_RAWDecoder: '{41945702-8302-44A6-9445-AC98E8AFA086}',
    CLSID_DefaultFormatConverter: '{1A3F11DC-B514-4B17-8C5F-2154513852F1}',
    CLSID_FormatConverterHighColor: '{AC75D454-9F37-48F8-B972-4E19BC856011}',
    CLSID_FormatConverterNChannel: '{C17CABB2-D4A3-47D7-A557-339B2EFBD4F1}',
    CLSID_FormatConverterWMPhoto: '{9CB5172B-D600-46BA-AB77-77BB7E3A00D9}',
    CLSID_PlanarFormatConverter: '{184132B8-32F8-4784-9131-DD7224B23438}',
    ContainerFormatBmp: '{0AF1D87E-FCFE-4188-BDEB-A7906471CBE3}',
    ContainerFormatPng: '{1B7CFAF4-713F-473C-BBCD-6137425FAEAF}',
    ContainerFormatIco: '{A3A860C4-338F-4C17-919A-FBA4B5628F21}',
    ContainerFormatJpeg: '{19E4A5AA-5662-4FC5-A0C0-1758028E1057}',
    ContainerFormatTiff: '{163BCC30-E2E9-4F0B-961D-A3E9FDB788A3}',
    ContainerFormatGif: '{1F8A5601-7D4D-4CBD-9C82-1BC8D4EEB9A5}',
    ContainerFormatWmp: '{57A37CAA-367A-4540-916B-F183C5093A4B}',
    ContainerFormatDds: '{9967CB95-2E85-4AC8-8CA2-83D7CCD425C9}',
    ContainerFormatAdng: '{F3FF6D0D-38C0-41C4-B1FE-1F3824F17B84}',
    ContainerFormatHeif: '{E1E62521-6787-405B-A339-500715B5763F}',
    ContainerFormatWebp: '{E094B0E2-67F2-45B3-B0EA-115337CA7CF3}',
    ContainerFormatRaw: '{FE99CE60-F19C-433C-A3AE-00ACEFA9CA21}',
    VendorMicrosoft: '{F0E749CA-EDEF-4589-A73A-EE0E626A2A2B}',
    VendorMicrosoftBuiltIn: '{257A30FD-06B6-462B-AEA4-63F70B86E533}',
    CLSID_ImagingCategories: '{FAE3D380-FEA4-4623-8C75-C6B61110B681}',
    CATID_BitmapDecoders: '{7ED96837-96F0-4812-B211-F13C24117ED3}',
    CATID_BitmapEncoders: '{AC757296-3522-4E11-9862-C17BE5A1767E}',
    CATID_FormatConverters: '{7835EAE8-BF14-49D1-93CE-533A407B2248}',
    CATID_MetadataReader: '{05AF94D8-7174-4CD2-BE4A-4124B80EE4B8}',
    CATID_MetadataWriter: '{ABE3B9A4-257D-4B97-BD1A-294AF496222E}',
    CATID_PixelFormats: '{2B46E70F-CDA7-473E-89F6-DC9630A2390B}',
});
