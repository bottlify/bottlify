/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// Written by tools/uia-ids.mjs from the SDK headers; do not edit.

/**
 * UI Automation's identifiers: [AutomationIdentifierType, GUID, number],
 * the type 0 property, 1 pattern, 2 event, 3 control type, 4 text
 * attribute, 5 landmark, 6 annotation, 7 change, 8 style.
 *
 * @type {ReadonlyArray<readonly [number, string, number]>}
 */
export const UIA_IDS = Object.freeze([
    [0, '{A39EEBFA-7FBA-4C89-B4D4-B99E2DE7D160}', 30000], // RuntimeId_Property
    [0, '{7BBFE8B2-3BFC-48DD-B729-C794B846E9A1}', 30001], // BoundingRectangle_Property
    [0, '{40499998-9C31-4245-A403-87320E59EAF6}', 30002], // ProcessId_Property
    [0, '{CA774FEA-28AC-4BC2-94CA-ACEC6D6C10A3}', 30003], // ControlType_Property
    [0, '{8763404F-A1BD-452A-89C4-3F01D3833806}', 30004], // LocalizedControlType_Property
    [0, '{C3A6921B-4A99-44F1-BCA6-61187052C431}', 30005], // Name_Property
    [0, '{514865DF-2557-4CB9-AEED-6CED084CE52C}', 30006], // AcceleratorKey_Property
    [0, '{06827B12-A7F9-4A15-917C-FFA5AD3EB0A7}', 30007], // AccessKey_Property
    [0, '{CF8AFD39-3F46-4800-9656-B2BF12529905}', 30008], // HasKeyboardFocus_Property
    [0, '{F7B8552A-0859-4B37-B9CB-51E72092F29F}', 30009], // IsKeyboardFocusable_Property
    [0, '{2109427F-DA60-4FED-BF1B-264BDCE6EB3A}', 30010], // IsEnabled_Property
    [0, '{C82C0500-B60E-4310-A267-303C531F8EE5}', 30011], // AutomationId_Property
    [0, '{157B7215-894F-4B65-84E2-AAC0DA08B16B}', 30012], // ClassName_Property
    [0, '{08555685-0977-45C7-A7A6-ABAF5684121A}', 30013], // HelpText_Property
    [0, '{0196903B-B203-4818-A9F3-F08E675F2341}', 30014], // ClickablePoint_Property
    [0, '{E2D74F27-3D79-4DC2-B88B-3044963A8AFB}', 30015], // Culture_Property
    [0, '{95F35085-ABCC-4AFD-A5F4-DBB46C230FDB}', 30016], // IsControlElement_Property
    [0, '{4BDA64A8-F5D8-480B-8155-EF2E89ADB672}', 30017], // IsContentElement_Property
    [0, '{E5B8924B-FC8A-4A35-8031-CF78AC43E55E}', 30018], // LabeledBy_Property
    [0, '{E8482EB1-687C-497B-BEBC-03BE53EC1454}', 30019], // IsPassword_Property
    [0, '{5196B33B-380A-4982-95E1-91F3EF60E024}', 30020], // NewNativeWindowHandle_Property
    [0, '{CDDA434D-6222-413B-A68A-325DD1D40F39}', 30021], // ItemType_Property
    [0, '{03C3D160-DB79-42DB-A2EF-1C231EEDE507}', 30022], // IsOffscreen_Property
    [0, '{A01EEE62-3884-4415-887E-678EC21E39BA}', 30023], // Orientation_Property
    [0, '{DBFD9900-7E1A-4F58-B61B-7063120F773B}', 30024], // FrameworkId_Property
    [0, '{4F5F43CF-59FB-4BDE-A270-602E5E1141E9}', 30025], // IsRequiredForForm_Property
    [0, '{51DE0321-3973-43E7-8913-0B08E813C37F}', 30026], // ItemStatus_Property
    [0, '{2600A4C4-2FF8-4C96-AE31-8FE619A13C6C}', 30027], // IsDockPatternAvailable_Property
    // IsExpandCollapsePatternAvailable_Property
    [0, '{929D3806-5287-4725-AA16-222AFC63D595}', 30028],
    [0, '{5A43E524-F9A2-4B12-84C8-B48A3EFEDD34}', 30029], // IsGridItemPatternAvailable_Property
    [0, '{5622C26C-F0EF-4F3B-97CB-714C0868588B}', 30030], // IsGridPatternAvailable_Property
    [0, '{4E725738-8364-4679-AA6C-F3F41931F750}', 30031], // IsInvokePatternAvailable_Property
    [0, '{FF0A31EB-8E25-469D-8D6E-E771A27C1B90}', 30032], // IsMultipleViewPatternAvailable_Property
    [0, '{FDA4244A-EB4D-43FF-B5AD-ED36D373EC4C}', 30033], // IsRangeValuePatternAvailable_Property
    [0, '{3EBB7B4A-828A-4B57-9D22-2FEA1632ED0D}', 30034], // IsScrollPatternAvailable_Property
    [0, '{1CAD1A05-0927-4B76-97E1-0FCDB209B98A}', 30035], // IsScrollItemPatternAvailable_Property
    // IsSelectionItemPatternAvailable_Property
    [0, '{8BECD62D-0BC3-4109-BEE2-8E6715290E68}', 30036],
    [0, '{F588ACBE-C769-4838-9A60-2686DC1188C4}', 30037], // IsSelectionPatternAvailable_Property
    [0, '{CB83575F-45C2-4048-9C76-159715A139DF}', 30038], // IsTablePatternAvailable_Property
    [0, '{EB36B40D-8EA4-489B-A013-E60D5951FE34}', 30039], // IsTableItemPatternAvailable_Property
    [0, '{FBE2D69D-AFF6-4A45-82E2-FC92A82F5917}', 30040], // IsTextPatternAvailable_Property
    [0, '{78686D53-FCD0-4B83-9B78-5832CE63BB5B}', 30041], // IsTogglePatternAvailable_Property
    [0, '{A7F78804-D68B-4077-A5C6-7A5EA1AC31C5}', 30042], // IsTransformPatternAvailable_Property
    [0, '{0B5020A7-2119-473B-BE37-5CEB98BBFB22}', 30043], // IsValuePatternAvailable_Property
    [0, '{E7A57BB1-5888-4155-98DC-B422FD57F2BC}', 30044], // IsWindowPatternAvailable_Property
    [0, '{E95F5E64-269F-4A85-BA99-4092C3EA2986}', 30045], // Value_Value_Property
    [0, '{EB090F30-E24C-4799-A705-0D247BC037F8}', 30046], // Value_IsReadOnly_Property
    [0, '{131F5D98-C50C-489D-ABE5-AE220898C5F7}', 30047], // RangeValue_Value_Property
    [0, '{25FA1055-DEBF-4373-A79E-1F1A1908D3C4}', 30048], // RangeValue_IsReadOnly_Property
    [0, '{78CBD3B2-684D-4860-AF93-D1F95CB022FD}', 30049], // RangeValue_Minimum_Property
    [0, '{19319914-F979-4B35-A1A6-D37E05433473}', 30050], // RangeValue_Maximum_Property
    [0, '{A1F96325-3A3D-4B44-8E1F-4A46D9844019}', 30051], // RangeValue_LargeChange_Property
    [0, '{81C2C457-3941-4107-9975-139760F7C072}', 30052], // RangeValue_SmallChange_Property
    [0, '{C7C13C0E-EB21-47FF-ACC4-B5A3350F5191}', 30053], // Scroll_HorizontalScrollPercent_Property
    [0, '{70C2E5D4-FCB0-4713-A9AA-AF92FF79E4CD}', 30054], // Scroll_HorizontalViewSize_Property
    [0, '{6C8D7099-B2A8-4948-BFF7-3CF9058BFEFB}', 30055], // Scroll_VerticalScrollPercent_Property
    [0, '{DE6A2E22-D8C7-40C5-83BA-E5F681D53108}', 30056], // Scroll_VerticalViewSize_Property
    [0, '{8B925147-28CD-49AE-BD63-F44118D2E719}', 30057], // Scroll_HorizontallyScrollable_Property
    [0, '{89164798-0068-4315-B89A-1E7CFBBC3DFC}', 30058], // Scroll_VerticallyScrollable_Property
    [0, '{AA6DC2A2-0E2B-4D38-96D5-34E470B81853}', 30059], // Selection_Selection_Property
    [0, '{49D73DA5-C883-4500-883D-8FCF8DAF6CBE}', 30060], // Selection_CanSelectMultiple_Property
    [0, '{B1AE4422-63FE-44E7-A5A5-A738C829B19A}', 30061], // Selection_IsSelectionRequired_Property
    [0, '{2A9505BF-C2EB-4FB6-B356-8245AE53703E}', 30062], // Grid_RowCount_Property
    [0, '{FE96F375-44AA-4536-AC7A-2A75D71A3EFC}', 30063], // Grid_ColumnCount_Property
    [0, '{6223972A-C945-4563-9329-FDC974AF2553}', 30064], // GridItem_Row_Property
    [0, '{C774C15C-62C0-4519-8BDC-47BE573C8AD5}', 30065], // GridItem_Column_Property
    [0, '{4582291C-466B-4E93-8E83-3D1715EC0C5E}', 30066], // GridItem_RowSpan_Property
    [0, '{583EA3F5-86D0-4B08-A6EC-2C5463FFC109}', 30067], // GridItem_ColumnSpan_Property
    [0, '{9D912252-B97F-4ECC-8510-EA0E33427C72}', 30068], // GridItem_Parent_Property
    [0, '{6D67F02E-C0B0-4B10-B5B9-18D6ECF98760}', 30069], // Dock_DockPosition_Property
    // ExpandCollapse_ExpandCollapseState_Property
    [0, '{275A4C48-85A7-4F69-ABA0-AF157610002B}', 30070],
    [0, '{7A81A67A-B94F-4875-918B-65C8D2F998E5}', 30071], // MultipleView_CurrentView_Property
    [0, '{8D5DB9FD-CE3C-4AE7-B788-400A3C645547}', 30072], // MultipleView_SupportedViews_Property
    [0, '{64FFF53F-635D-41C1-950C-CB5ADFBE28E3}', 30073], // Window_CanMaximize_Property
    [0, '{B73B4625-5988-4B97-B4C2-A6FE6E78C8C6}', 30074], // Window_CanMinimize_Property
    [0, '{4AB7905F-E860-453E-A30A-F6431E5DAAD5}', 30075], // Window_WindowVisualState_Property
    [0, '{4FED26A4-0455-4FA2-B21C-C4DA2DB1FF9C}', 30076], // Window_WindowInteractionState_Property
    [0, '{FF4E6892-37B9-4FCA-8532-FFE674ECFEED}', 30077], // Window_IsModal_Property
    [0, '{EF7D85D3-0937-4962-9241-B62345F24041}', 30078], // Window_IsTopmost_Property
    [0, '{F122835F-CD5F-43DF-B79D-4B849E9E6020}', 30079], // SelectionItem_IsSelected_Property
    // SelectionItem_SelectionContainer_Property
    [0, '{A4365B6E-9C1E-4B63-8B53-C2421DD1E8FB}', 30080],
    [0, '{D9E35B87-6EB8-4562-AAC6-A8A9075236A8}', 30081], // Table_RowHeaders_Property
    [0, '{AFF1D72B-968D-42B1-B459-150B299DA664}', 30082], // Table_ColumnHeaders_Property
    [0, '{83BE75C3-29FE-4A30-85E1-2A6277FD106E}', 30083], // Table_RowOrColumnMajor_Property
    [0, '{B3F853A0-0574-4CD8-BCD7-ED5923572D97}', 30084], // TableItem_RowHeaderItems_Property
    [0, '{967A56A3-74B6-431E-8DE6-99C411031C58}', 30085], // TableItem_ColumnHeaderItems_Property
    [0, '{B23CDC52-22C2-4C6C-9DED-F5C422479EDE}', 30086], // Toggle_ToggleState_Property
    [0, '{1B75824D-208B-4FDF-BCCD-F1F4E5741F4F}', 30087], // Transform_CanMove_Property
    [0, '{BB98DCA5-4C1A-41D4-A4F6-EBC128644180}', 30088], // Transform_CanResize_Property
    [0, '{10079B48-3849-476F-AC96-44A95C8440D9}', 30089], // Transform_CanRotate_Property
    // IsLegacyIAccessiblePatternAvailable_Property
    [0, '{D8EBD0C7-929A-4EE7-8D3A-D3D94413027B}', 30090],
    [0, '{9A191B5D-9EF2-4787-A459-DCDE885DD4E8}', 30091], // LegacyIAccessible_ChildId_Property
    [0, '{CAEB063D-40AE-4869-AA5A-1B8E5D666739}', 30092], // LegacyIAccessible_Name_Property
    [0, '{B5C5B0B6-8217-4A77-97A5-190A85ED0156}', 30093], // LegacyIAccessible_Value_Property
    [0, '{46448418-7D70-4EA9-9D27-B7E775CF2AD7}', 30094], // LegacyIAccessible_Description_Property
    [0, '{6856E59F-CBAF-4E31-93E8-BCBF6F7E491C}', 30095], // LegacyIAccessible_Role_Property
    [0, '{DF985854-2281-4340-AB9C-C60E2C5803F6}', 30096], // LegacyIAccessible_State_Property
    [0, '{94402352-161C-4B77-A98D-A872CC33947A}', 30097], // LegacyIAccessible_Help_Property
    // LegacyIAccessible_KeyboardShortcut_Property
    [0, '{8F6909AC-00B8-4259-A41C-966266D43A8A}', 30098],
    [0, '{8AA8B1E0-0891-40CC-8B06-90D7D4166219}', 30099], // LegacyIAccessible_Selection_Property
    // LegacyIAccessible_DefaultAction_Property
    [0, '{3B331729-EAAD-4502-B85F-92615622913C}', 30100],
    [0, '{DD207B95-BE4A-4E0D-B727-63ACE94B6916}', 30101], // AriaRole_Property
    [0, '{4213678C-E025-4922-BEB5-E43BA08E6221}', 30102], // AriaProperties_Property
    [0, '{445AC684-C3FC-4DD9-ACF8-845A579296BA}', 30103], // IsDataValidForForm_Property
    [0, '{51124C8A-A5D2-4F13-9BE6-7FA8BA9D3A90}', 30104], // ControllerFor_Property
    [0, '{7C5865B8-9992-40FD-8DB0-6BF1D317F998}', 30105], // DescribedBy_Property
    [0, '{E4F33D20-559A-47FB-A830-F9CB4FF1A70A}', 30106], // FlowsTo_Property
    [0, '{DCA5708A-C16B-4CD9-B889-BEB16A804904}', 30107], // ProviderDescription_Property
    // IsItemContainerPatternAvailable_Property
    [0, '{624B5CA7-FE40-4957-A019-20C4CF11920F}', 30108],
    // IsVirtualizedItemPatternAvailable_Property
    [0, '{302CB151-2AC8-45D6-977B-D2B3A5A53F20}', 30109],
    // IsSynchronizedInputPatternAvailable_Property
    [0, '{75D69CC5-D2BF-4943-876E-B45B62A6CC66}', 30110],
    [0, '{6A852250-C75A-4E5D-B858-E381B0F78861}', 30111], // OptimizeForVisualContent_Property
    [0, '{6B21D89B-2841-412F-8EF2-15CA952318BA}', 30112], // IsObjectModelPatternAvailable_Property
    [0, '{20AE484F-69EF-4C48-8F5B-C4938B206AC7}', 30113], // Annotation_AnnotationTypeId_Property
    [0, '{9B818892-5AC9-4AF9-AA96-F58A77B058E3}', 30114], // Annotation_AnnotationTypeName_Property
    [0, '{7A528462-9C5C-4A03-A974-8B307A9937F2}', 30115], // Annotation_Author_Property
    [0, '{99B5CA5D-1ACF-414B-A4D0-6B350B047578}', 30116], // Annotation_DateTime_Property
    [0, '{B71B302D-2104-44AD-9C5C-092B4907D70F}', 30117], // Annotation_Target_Property
    [0, '{0B5B3238-6D5C-41B6-BCC4-5E807F6551C4}', 30118], // IsAnnotationPatternAvailable_Property
    [0, '{41CF921D-E3F1-4B22-9C81-E1C3ED331C22}', 30119], // IsTextPattern2Available_Property
    [0, '{DA82852F-3817-4233-82AF-02279E72CC77}', 30120], // Styles_StyleId_Property
    [0, '{1C12B035-05D1-4F55-9E8E-1489F3FF550D}', 30121], // Styles_StyleName_Property
    [0, '{63EFF97A-A1C5-4B1D-84EB-B765F2EDD632}', 30122], // Styles_FillColor_Property
    [0, '{81CF651F-482B-4451-A30A-E1545E554FB8}', 30123], // Styles_FillPatternStyle_Property
    [0, '{C71A23F8-778C-400D-8458-3B543E526984}', 30124], // Styles_Shape_Property
    [0, '{939A59FE-8FBD-4E75-A271-AC4595195163}', 30125], // Styles_FillPatternColor_Property
    [0, '{F451CDA0-BA0A-4681-B0B0-0DBDB53E58F3}', 30126], // Styles_ExtendedProperties_Property
    [0, '{27F353D3-459C-4B59-A490-50611DACAFB5}', 30127], // IsStylesPatternAvailable_Property
    [0, '{6FF43732-E4B4-4555-97BC-ECDBBC4D1888}', 30128], // IsSpreadsheetPatternAvailable_Property
    [0, '{E602E47D-1B47-4BEA-87CF-3B0B0B5C15B6}', 30129], // SpreadsheetItem_Formula_Property
    // SpreadsheetItem_AnnotationObjects_Property
    [0, '{A3194C38-C9BC-4604-9396-AE3F9F457F7B}', 30130],
    // SpreadsheetItem_AnnotationTypes_Property
    [0, '{C70C51D0-D602-4B45-AFBC-B4712B96D72B}', 30131],
    // IsSpreadsheetItemPatternAvailable_Property
    [0, '{9FE79B2A-2F94-43FD-996B-549E316F4ACD}', 30132],
    [0, '{F357E890-A756-4359-9CA6-86702BF8F381}', 30133], // Transform2_CanZoom_Property
    [0, '{25980B4B-BE04-4710-AB4A-FDA31DBD2895}', 30134], // IsTransformPattern2Available_Property
    [0, '{C12BCD8E-2A8E-4950-8AE7-3625111D58EB}', 30135], // LiveSetting_Property
    [0, '{559E65DF-30FF-43B5-B5ED-5B283B80C7E9}', 30136], // IsTextChildPatternAvailable_Property
    [0, '{E997A7B7-1D39-4CA7-BE0F-277FCF5605CC}', 30137], // IsDragPatternAvailable_Property
    [0, '{45F206F3-75CC-4CCA-A9B9-FCDFB982D8A2}', 30138], // Drag_IsGrabbed_Property
    [0, '{646F2779-48D3-4B23-8902-4BF100005DF3}', 30139], // Drag_DropEffect_Property
    [0, '{F5D61156-7CE6-49BE-A836-9269DCEC920F}', 30140], // Drag_DropEffects_Property
    [0, '{0686B62E-8E19-4AAF-873D-384F6D3B92BE}', 30141], // IsDropTargetPatternAvailable_Property
    [0, '{8BB75975-A0CA-4981-B818-87FC66E9509D}', 30142], // DropTarget_DropTargetEffect_Property
    [0, '{BC1DD4ED-CB89-45F1-A592-E03B08AE790F}', 30143], // DropTarget_DropTargetEffects_Property
    [0, '{77C1562C-7B86-4B21-9ED7-3CEFDA6F4C43}', 30144], // Drag_GrabbedItems_Property
    [0, '{EEE29F1A-F4A2-4B5B-AC65-95CF93283387}', 30145], // Transform2_ZoomLevel_Property
    [0, '{742CCC16-4AD1-4E07-96FE-B122C6E6B22B}', 30146], // Transform2_ZoomMinimum_Property
    [0, '{42AB6B77-CEB0-4ECA-B82A-6CFA5FA1FC08}', 30147], // Transform2_ZoomMaximum_Property
    [0, '{05C6844F-19DE-48F8-95FA-880D5B0FD615}', 30148], // FlowsFrom_Property
    [0, '{7843425C-8B32-484C-9AB5-E3200571FFDA}', 30149], // IsTextEditPatternAvailable_Property
    [0, '{DA758276-7ED5-49D4-8E68-ECC9A2D300DD}', 30150], // IsPeripheral_Property
    // IsCustomNavigationPatternAvailable_Property
    [0, '{8F8E80D4-2351-48E0-874A-54AA7313889A}', 30151],
    [0, '{33D1DC54-641E-4D76-A6B1-13F341C1F896}', 30152], // PositionInSet_Property
    [0, '{1600D33C-3B9F-4369-9431-AA293F344CF1}', 30153], // SizeOfSet_Property
    [0, '{242AC529-CD36-400F-AAD9-7876EF3AF627}', 30154], // Level_Property
    [0, '{64B71F76-53C4-4696-A219-20E940C9A176}', 30155], // AnnotationTypes_Property
    [0, '{310910C8-7C6E-4F20-BECD-4AAF6D191156}', 30156], // AnnotationObjects_Property
    [0, '{454045F2-6F61-49F7-A4F8-B5F0CF82DA1E}', 30157], // LandmarkType_Property
    [0, '{7AC81980-EAFB-4FB2-BF91-F485BEF5E8E1}', 30158], // LocalizedLandmarkType_Property
    [0, '{0D4450FF-6AEF-4F33-95DD-7BEFA72A4391}', 30159], // FullDescription_Property
    [0, '{6E0EC4D0-E2A8-4A56-9DE7-953389933B39}', 30160], // FillColor_Property
    [0, '{C395D6C0-4B55-4762-A073-FD303A634F52}', 30161], // OutlineColor_Property
    [0, '{C6FC74E4-8CB9-429C-A9E1-9BC4AC372B62}', 30162], // FillType_Property
    [0, '{E61A8565-AAD9-46D7-9E70-4E8A8420D420}', 30163], // VisualEffects_Property
    [0, '{13E67CC7-DAC2-4888-BDD3-375C62FA9618}', 30164], // OutlineThickness_Property
    [0, '{0CB00C08-540C-4EDB-9445-26359EA69785}', 30165], // CenterPoint_Property
    [0, '{767CDC7D-AEC0-4110-AD32-30EDD403492E}', 30166], // Rotation_Property
    [0, '{2B5F761D-F885-4404-973F-9B1D98E36D8F}', 30167], // Size_Property
    [0, '{490806FB-6E89-4A47-8319-D266E511F021}', 30168], // IsSelectionPattern2Available_Property
    [0, '{CC24EA67-369C-4E55-9FF7-38DA69540C29}', 30169], // Selection2_FirstSelectedItem_Property
    [0, '{CF7BDA90-2D83-49F8-860C-9CE394CF89B4}', 30170], // Selection2_LastSelectedItem_Property
    [0, '{34257C26-83B5-41A6-939C-AE841C136236}', 30171], // Selection2_CurrentSelectedItem_Property
    [0, '{BB49EB9F-456D-4048-B591-9C2026B84636}', 30172], // Selection2_ItemCount_Property
    [0, '{29084272-AAAF-4A30-8796-3C12F62B6BBB}', 30173], // HeadingLevel_Property
    [0, '{9D0DFB9B-8436-4501-BBBB-E534A4FB3B3F}', 30174], // IsDialog_Property
    [1, '{D976C2FC-66EA-4A6E-B28F-C24C7546AD37}', 10000], // Invoke_Pattern
    [1, '{66E3B7E8-D821-4D25-8761-435D2C8B253F}', 10001], // Selection_Pattern
    [1, '{17FAAD9E-C877-475B-B933-77332779B637}', 10002], // Value_Pattern
    [1, '{18B00D87-B1C9-476A-BFBD-5F0BDB926F63}', 10003], // RangeValue_Pattern
    [1, '{895FA4B4-759D-4C50-8E15-03460672003C}', 10004], // Scroll_Pattern
    [1, '{AE05EFA2-F9D1-428A-834C-53A5C52F9B8B}', 10005], // ExpandCollapse_Pattern
    [1, '{260A2CCB-93A8-4E44-A4C1-3DF397F2B02B}', 10006], // Grid_Pattern
    [1, '{F2D5C877-A462-4957-A2A5-2C96B303BC63}', 10007], // GridItem_Pattern
    [1, '{547A6AE4-113F-47C4-850F-DB4DFA466B1D}', 10008], // MultipleView_Pattern
    [1, '{27901735-C760-4994-AD11-5919E606B110}', 10009], // Window_Pattern
    [1, '{9BC64EEB-87C7-4B28-94BB-4D9FA437B6EF}', 10010], // SelectionItem_Pattern
    [1, '{9CBAA846-83C8-428D-827F-7E6063FE0620}', 10011], // Dock_Pattern
    [1, '{C415218E-A028-461E-AA92-8F925CF79351}', 10012], // Table_Pattern
    [1, '{DF1343BD-1888-4A29-A50C-B92E6DE37F6F}', 10013], // TableItem_Pattern
    [1, '{8615F05D-7DE5-44FD-A679-2CA4B46033A8}', 10014], // Text_Pattern
    [1, '{0B419760-E2F4-43FF-8C5F-9457C82B56E9}', 10015], // Toggle_Pattern
    [1, '{24B46FDB-587E-49F1-9C4A-D8E98B664B7B}', 10016], // Transform_Pattern
    [1, '{4591D005-A803-4D5C-B4D5-8D2800F906A7}', 10017], // ScrollItem_Pattern
    [1, '{54CC0A9F-3395-48AF-BA8D-73F85690F3E0}', 10018], // LegacyIAccessible_Pattern
    [1, '{3D13DA0F-8B9A-4A99-85FA-C5C9A69F1ED4}', 10019], // ItemContainer_Pattern
    [1, '{F510173E-2E71-45E9-A6E5-62F6ED8289D5}', 10020], // VirtualizedItem_Pattern
    [1, '{05C288A6-C47B-488B-B653-33977A551B8B}', 10021], // SynchronizedInput_Pattern
    [1, '{3E04ACFE-08FC-47EC-96BC-353FA3B34AA7}', 10022], // ObjectModel_Pattern
    [1, '{F6C72AD7-356C-4850-9291-316F608A8C84}', 10023], // Annotation_Pattern
    [1, '{498479A2-5B22-448D-B6E4-647490860698}', 10024], // Text_Pattern2
    [1, '{1AE62655-DA72-4D60-A153-E5AA6988E3BF}', 10025], // Styles_Pattern
    [1, '{6A5B24C9-9D1E-4B85-9E44-C02E3169B10B}', 10026], // Spreadsheet_Pattern
    [1, '{32CF83FF-F1A8-4A8C-8658-D47BA74E20BA}', 10027], // SpreadsheetItem_Pattern
    [1, '{8AFCFD07-A369-44DE-988B-2F7FF49FB8A8}', 10028], // Tranform_Pattern2
    [1, '{7533CAB7-3BFE-41EF-9E85-E2638CBE169E}', 10029], // TextChild_Pattern
    [1, '{C0BEE21F-CCB3-4FED-995B-114F6E3D2728}', 10030], // Drag_Pattern
    [1, '{0BCBEC56-BD34-4B7B-9FD5-2659905EA3DC}', 10031], // DropTarget_Pattern
    [1, '{69F3FF89-5AF9-4C75-9340-F2DE292E4591}', 10032], // TextEdit_Pattern
    [1, '{AFEA938A-621E-4054-BB2C-2F46114DAC3F}', 10033], // CustomNavigation_Pattern
    [2, '{3F4B97FF-2EDC-451D-BCA4-95A3188D5B03}', 20000], // ToolTipOpened_Event
    [2, '{276D71EF-24A9-49B6-8E97-DA98B401BBCD}', 20001], // ToolTipClosed_Event
    [2, '{59977961-3EDD-4B11-B13B-676B2A2A6CA9}', 20002], // StructureChanged_Event
    [2, '{EBE2E945-66CA-4ED1-9FF8-2AD7DF0A1B08}', 20003], // MenuOpened_Event
    [2, '{2527FBA1-8D7A-4630-A4CC-E66315942F52}', 20004], // AutomationPropertyChanged_Event
    [2, '{B68A1F17-F60D-41A7-A3CC-B05292155FE0}', 20005], // AutomationFocusChanged_Event
    [2, '{5FDEE11C-D2FA-4FB9-904E-5CBEE894D5EF}', 20006], // AsyncContentLoaded_Event
    [2, '{3CF1266E-1582-4041-ACD7-88A35A965297}', 20007], // MenuClosed_Event
    [2, '{ED7D6544-A6BD-4595-9BAE-3D28946CC715}', 20008], // LayoutInvalidated_Event
    [2, '{DFD699F0-C915-49DD-B422-DDE785C3D24B}', 20009], // Invoke_Invoked_Event
    // SelectionItem_ElementAddedToSelectionEvent_Event
    [2, '{3C822DD1-C407-4DBA-91DD-79D4AED0AEC6}', 20010],
    // SelectionItem_ElementRemovedFromSelectionEvent_Event
    [2, '{097FA8A9-7079-41AF-8B9C-0934D8305E5C}', 20011],
    // SelectionItem_ElementSelectedEvent_Event
    [2, '{B9C7DBFB-4EBE-4532-AAF4-008CF647233C}', 20012],
    [2, '{CAC14904-16B4-4B53-8E47-4CB1DF267BB7}', 20013], // Selection_InvalidatedEvent_Event
    [2, '{918EDAA1-71B3-49AE-9741-79BEB8D358F3}', 20014], // Text_TextSelectionChangedEvent_Event
    [2, '{4A342082-F483-48C4-AC11-A84B435E2A84}', 20015], // Text_TextChangedEvent_Event
    [2, '{D3E81D06-DE45-4F2F-9633-DE9E02FB65AF}', 20016], // Window_WindowOpened_Event
    [2, '{EDF141F8-FA67-4E22-BBF7-944E05735EE2}', 20017], // Window_WindowClosed_Event
    [2, '{18D7C631-166A-4AC9-AE3B-EF4B5420E681}', 20018], // MenuModeStart_Event
    [2, '{9ECD4C9F-80DD-47B8-8267-5AEC06BB2CFF}', 20019], // MenuModeEnd_Event
    [2, '{93ED549A-0549-40F0-BEDB-28E44F7DE2A3}', 20020], // InputReachedTarget_Event
    [2, '{ED201D8A-4E6C-415E-A874-2460C9B66BA8}', 20021], // InputReachedOtherElement_Event
    [2, '{7F36C367-7B18-417C-97E3-9D58DDC944AB}', 20022], // InputDiscarded_Event
    [2, '{D271545D-7A3A-47A7-8474-81D29A2451C9}', 20023], // SystemAlert_Event
    [2, '{102D5E90-E6A9-41B6-B1C5-A9B1929D9510}', 20024], // LiveRegionChanged_Event
    [2, '{E6BDB03E-0921-4EC5-8DCF-EAE877B0426B}', 20025], // HostedFragmentRootsInvalidated_Event
    [2, '{883A480B-3AA9-429D-95E4-D9C8D011F0DD}', 20026], // Drag_DragStart_Event
    [2, '{C3EDE6FA-3451-4E0F-9E71-DF9C280A4657}', 20027], // Drag_DragCancel_Event
    [2, '{38E96188-EF1F-463E-91CA-3A7792C29CAF}', 20028], // Drag_DragComplete_Event
    [2, '{AAD9319B-032C-4A88-961D-1CF579581E34}', 20029], // DropTarget_DragEnter_Event
    [2, '{0F82EB15-24A2-4988-9217-DE162AEE272B}', 20030], // DropTarget_DragLeave_Event
    [2, '{622CEAD8-1EDB-4A3D-ABBC-BE2211FF68B5}', 20031], // DropTarget_Dropped_Event
    [2, '{120B0308-EC22-4EB8-9C98-9867CDA1B165}', 20032], // TextEdit_TextChanged_Event
    [2, '{3388C183-ED4F-4C8B-9BAA-364D51D8847F}', 20033], // TextEdit_ConversionTargetChanged_Event
    [2, '{7DF26714-614F-4E05-9488-716C5BA19436}', 20034], // Changes_Event
    [2, '{72C5A2F7-9788-480F-B8EB-4DEE00F6186F}', 20035], // Notification_Event
    [3, '{5A78E369-C6A1-4F33-A9D7-79F20D0C788E}', 50000], // Button_Control
    [3, '{8913EB88-00E5-46BC-8E4E-14A786E165A1}', 50001], // Calendar_Control
    [3, '{FB50F922-A3DB-49C0-8BC3-06DAD55778E2}', 50002], // CheckBox_Control
    [3, '{54CB426C-2F33-4FFF-AAA1-AEF60DAC5DEB}', 50003], // ComboBox_Control
    [3, '{6504A5C8-2C86-4F87-AE7B-1ABDDC810CF9}', 50004], // Edit_Control
    [3, '{8A56022C-B00D-4D15-8FF0-5B6B266E5E02}', 50005], // Hyperlink_Control
    [3, '{2D3736E4-6B16-4C57-A962-F93260A75243}', 50006], // Image_Control
    [3, '{7B3717F2-44D1-4A58-98A8-F12A9B8F78E2}', 50007], // ListItem_Control
    [3, '{9B149EE1-7CCA-4CFC-9AF1-CAC7BDDD3031}', 50008], // List_Control
    [3, '{2E9B1440-0EA8-41FD-B374-C1EA6F503CD1}', 50009], // Menu_Control
    [3, '{CC384250-0E7B-4AE8-95AE-A08F261B52EE}', 50010], // MenuBar_Control
    [3, '{F45225D3-D0A0-49D8-9834-9A000D2AEDDC}', 50011], // MenuItem_Control
    [3, '{228C9F86-C36C-47BB-9FB6-A5834BFC53A4}', 50012], // ProgressBar_Control
    [3, '{3BDB49DB-FE2C-4483-B3E1-E57F219440C6}', 50013], // RadioButton_Control
    [3, '{DAF34B36-5065-4946-B22F-92595FC0751A}', 50014], // ScrollBar_Control
    [3, '{B033C24B-3B35-4CEA-B609-763682FA660B}', 50015], // Slider_Control
    [3, '{60CC4B38-3CB1-4161-B442-C6B726C17825}', 50016], // Spinner_Control
    [3, '{D45E7D1B-5873-475F-95A4-0433E1F1B00A}', 50017], // StatusBar_Control
    [3, '{38CD1F2D-337A-4BD2-A5E3-ADB469E30BD3}', 50018], // Tab_Control
    [3, '{2C6A634F-921B-4E6E-B26E-08FCB0798F4C}', 50019], // TabItem_Control
    [3, '{AE9772DC-D331-4F09-BE20-7E6DFAF07B0A}', 50020], // Text_Control
    [3, '{8F06B751-E182-4E98-8893-2284543A7DCE}', 50021], // ToolBar_Control
    [3, '{05DDC6D1-2137-4768-98EA-73F52F7134F3}', 50022], // ToolTip_Control
    [3, '{7561349C-D241-43F4-9908-B5F091BEE611}', 50023], // Tree_Control
    [3, '{62C9FEB9-8FFC-4878-A3A4-96B030315C18}', 50024], // TreeItem_Control
    [3, '{F29EA0C3-ADB7-430A-BA90-E52C7313E6ED}', 50025], // Custom_Control
    [3, '{AD50AA1C-E8C8-4774-AE1B-DD86DF0B3BDC}', 50026], // Group_Control
    [3, '{701CA877-E310-4DD6-B644-797E4FAEA213}', 50027], // Thumb_Control
    [3, '{84B783AF-D103-4B0A-8415-E73942410F4B}', 50028], // DataGrid_Control
    [3, '{A0177842-D94F-42A5-814B-6068ADDC8DA5}', 50029], // DataItem_Control
    [3, '{3CD6BB6F-6F08-4562-B229-E4E2FC7A9EB4}', 50030], // Document_Control
    [3, '{7011F01F-4ACE-4901-B461-920A6F1CA650}', 50031], // SplitButton_Control
    [3, '{E13A7242-F462-4F4D-AEC1-53B28D6C3290}', 50032], // Window_Control
    [3, '{5C2B3F5B-9182-42A3-8DEC-8C04C1EE634D}', 50033], // Pane_Control
    [3, '{5B90CBCE-78FB-4614-82B6-554D74718E67}', 50034], // Header_Control
    [3, '{E6BC12CB-7C8E-49CF-B168-4A93A32BEBB0}', 50035], // HeaderItem_Control
    [3, '{773BFA0E-5BC4-4DEB-921B-DE7B3206229E}', 50036], // Table_Control
    [3, '{98AA55BF-3BB0-4B65-836E-2EA30DBC171F}', 50037], // TitleBar_Control
    [3, '{8767EBA3-2A63-4AB0-AC8D-AA50E23DE978}', 50038], // Separator_Control
    [3, '{5FD34A43-061E-42C8-B589-9DCCF74BC43A}', 50039], // SemanticZoom_Control
    [3, '{6114908D-CC02-4D37-875B-B530C7139554}', 50040], // AppBar_Control
]);
